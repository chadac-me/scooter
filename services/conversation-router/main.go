// conversation-router fronts the agent-host Service and reverse-proxies each request to
// the agent-host pod that owns the conversation (status.hostIP on the Conversation CR).
// httputil.ReverseProxy handles HTTP, SSE and WebSocket upgrades alike.
//
// Flow per request:
//  1. extract the conversation id (agui body threadId / path route);
//  2. resolve its pod from the row, claiming if unassigned;
//  3. proxy there; only conversation-less requests go to any pod.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

type config struct {
	namespace    string
	upstreamPort int // agent-host container port
	listenAddr   string
	// The agent-host ClusterIP Service, for requests that name no conversation.
	clusterIPService string
	// The ClusterIP Service in cluster, or AGENT_HOST_URL in dev mode.
	fallback *url.URL
}

func configFromEnv() config {
	return config{
		namespace:        env("NAMESPACE", "agent-sandbox"),
		upstreamPort:     atoi(env("UPSTREAM_PORT", "8080")),
		listenAddr:       env("LISTEN_ADDR", ":8080"),
		clusterIPService: env("AGENT_HOST_SERVICE", "agent-host"),
	}
}

func main() {
	setupLogging()
	log := logger("main")

	cfg := configFromEnv()
	// ctx is the process-lifetime context, handed to the proxy layer so a shutdown cancellation can be told apart from a client hanging up (see classifyProxyError).
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	var creator ConversationCreator
	// Nil in dev mode, where every request goes to AGENT_HOST_URL.
	var pods *ReadyPods
	var dynClient dynamic.Interface
	// Body-`owner` trust for in-cluster callers; nil outside a cluster, where a body owner is never honored.
	var trusted TrustedCaller
	if devModeEnabled() {
		u, err := agentHostURLFromEnv()
		if err != nil {
			log.Error("ROUTER_DEV_MODE misconfigured", errAttr(err))
			os.Exit(1)
		}
		dc, err := OpenDevCreator(ctx, storeDSNFromEnv())
		if err != nil {
			log.Error("ROUTER_DEV_MODE dev creator init failed", errAttr(err))
			os.Exit(1)
		}
		defer dc.Close()
		cfg.fallback = u
		creator = dc
		log.Warn("ROUTER_DEV_MODE: kube-less single-host stack (no CRD watch, single upstream)",
			slog.String("agent_host_url", u.String()))
	} else {
		dyn, kubeCfg, err := newDynamicClient()
		if err != nil {
			log.Error("k8s client init failed", errAttr(err))
			os.Exit(1)
		}
		dynClient = dyn
		pods = NewReadyPods()
		go pods.Run(ctx, dyn, cfg.namespace)
		creator = &dynamicCreator{dyn: dyn, namespace: cfg.namespace}
		cfg.fallback = FallbackURL(cfg.clusterIPService, cfg.namespace, cfg.upstreamPort)
		trusted = buildTrustedCaller(kubeCfg, log)
	}

	// Optional read-only Postgres handle on the agent_host database, from which GET /conversations is served.
	var store *Store
	if dsn := storeDSNFromEnv(); dsn != "" {
		s, err := OpenStore(ctx, dsn)
		if err != nil {
			log.Warn("postgres read store unavailable (list falls back to fleet aggregate)", errAttr(err))
		} else {
			store = s
			defer store.Close()
			// Prove the SELECT grant at boot rather than when the list is first served.
			vctx, vcancel := context.WithTimeout(ctx, verifyTimeout)
			if n, err := store.CountConversations(vctx); err != nil {
				log.Warn("postgres read store verify failed (list falls back to fleet aggregate)", errAttr(err))
			} else {
				log.Info("postgres read store connected", slog.Int64("conversations", n))
			}
			vcancel()
		}
	}

	// Optional cluster-only write handle for idle star/title PATCHes; dev has no CR watch to tell idle from live, so it proxies instead.
	var writeStore *WriteStore
	if !devModeEnabled() {
		if dsn := storeDSNFromEnv(); dsn != "" {
			ws, err := OpenWriteStore(ctx, dsn)
			if err != nil {
				log.Warn("postgres write store unavailable (metadata PATCH falls back to proxy)", errAttr(err))
			} else {
				writeStore = ws
				defer writeStore.Close()
				log.Info("postgres write store connected (idle star/title served here)")
			}
		}
	}

	// Dual-write the create row alongside the CR in the cluster path; dev already writes the row and has no CR.
	if writeStore != nil {
		creator = &dualCreator{cr: creator, rows: writeStore}
		log.Info("conversation create dual-writes the row alongside the CR")
	}

	// Optional read-only handle on the webhooks database for link enrichment; without it the list serves bare rows.
	var links *LinkStore
	if dsn := linkStoreDSNFromEnv(); dsn != "" {
		l, err := OpenLinkStore(ctx, dsn)
		if err != nil {
			log.Warn("links read store unavailable (list served without enrichment)", errAttr(err))
		} else {
			links = l
			defer links.Close()
			log.Info("links read store connected")
		}
	}

	var resolver ownerResolver
	if pods != nil && writeStore != nil {
		assigner := NewAssigner(&PgAssignStore{pool: writeStore.pool}, pods)
		assigner.OnClaim = mirrorClaim(dynClient, cfg.namespace)
		go runAssignListener(ctx, writeStore.pool.Config().ConnConfig, assigner)
		resolver = assigner
		log.Info("routing by the conversations row")
	} else if pods != nil {
		log.Error("no write store: conversations cannot be assigned, routing to any pod")
	}

	// The live conversation-list push: one LISTEN connection fans NOTIFYs out to SSE subscribers (see events.go).
	hub := newSSEHub()
	go runConversationListener(ctx, store, links, hub)

	srv := &http.Server{Addr: cfg.listenAddr, Handler: newRouter(ctx, cfg, resolver, creator, trusted, store, writeStore, links, hub)}
	go func() {
		<-ctx.Done()
		log.Info("shutdown signalled, draining")
		sctx, c := context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
		_ = srv.Shutdown(sctx) // drains in-flight requests
	}()
	log.Info("listening",
		slog.String("listen_addr", cfg.listenAddr),
		slog.String("namespace", cfg.namespace),
		slog.String("agent_host_service", cfg.clusterIPService))
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Error("serve failed", errAttr(err))
		os.Exit(1)
	}
	log.Info("stopped")
}

// newRouter builds the HTTP handler: resolve the target, reverse-proxy, and on a dial failure to the owner IP retry once via the fallback Service.
func newRouter(shutdownCtx context.Context, cfg config, resolver ownerResolver, creator ConversationCreator, trusted TrustedCaller, store *Store, writeStore *WriteStore, links *LinkStore, hub *sseHub) http.Handler {
	fallback := cfg.fallback
	// A typed-nil *Store in an interface is not nil.
	var parents parentLookup
	if store != nil {
		parents = store
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Create, the conversation list and its events stream are served here rather than proxied: no single agent-host pod knows every conversation, and a capacity-bound pod cannot create one (see create.go, list.go, events.go).
		if IsConversationCreate(r.Method, r.URL.Path) {
			serveConversationCreate(w, r, creator, ownerFrom(r), trusted)
			return
		}
		// Subagent create is served here too (see subagent.go).
		if parentID, ok := SubagentCreate(r.Method, r.URL.Path); ok {
			serveSubagentCreate(w, r, creator, parents, parentID, ownerFrom(r), trusted)
			return
		}
		if IsConversationListRoute(r.Method, r.URL.Path) {
			if store == nil {
				http.Error(w, "conversation store unavailable", http.StatusServiceUnavailable)
				return
			}
			if isSSE(r) {
				serveConversationEvents(w, r, store, links, hub)
			} else {
				serveConversationList(w, r, store, links)
			}
			return
		}
		// Idle star/title is served here; a live conversation falls through to the proxy so its owner stays the single writer.
		if writeStore != nil && store != nil {
			if field, id, ok := MetadataPatch(r.Method, r.URL.Path); ok {
				if resolver == nil || !resolver.Assigned(r.Context(), id) {
					serveConversationMetadataPatch(w, r, field, id, store, writeStore)
					return
				}
			}
		}
		// convID is resolved once and threaded into the proxy layer so every log line carries conversation_id.
		convID, target, err := resolveTargetFor(cfg, resolver, r, fallback)
		if errors.Is(err, ErrNoPods) {
			w.Header().Set("Retry-After", "2")
			http.Error(w, "no agent-host pod is ready", http.StatusServiceUnavailable)
			return
		}
		// Retry only when the primary target is an owner IP rather than the fallback.
		canRetry := target.Host != fallback.Host
		serveVia(shutdownCtx, w, r, target, fallback, canRetry, convID)
	})
}

// serveVia reverse-proxies r to `target`, retrying once against `fallback` on a pre-response dial failure when `retry` is set.
func serveVia(shutdownCtx context.Context, w http.ResponseWriter, r *http.Request, target, fallback *url.URL, retry bool, convID string) {
	log := logger("proxy")
	tw := &trackingWriter{ResponseWriter: w}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.FlushInterval = -1 // flush immediately for SSE
	proxy.ErrorHandler = func(ww http.ResponseWriter, rr *http.Request, e error) {
		kind := classifyProxyError(e, shutdownCtx, rr.Context())
		fields := []any{
			convAttr(convID),
			slog.String("upstream", target.Host),
			slog.String("method", rr.Method),
			slog.String("path", rr.URL.Path),
			slog.String("reason", kind.String()),
			errAttr(e),
		}

		// A routine ending (a reader gone, a finished body) is not an error, and nobody is left to receive a 502.
		if kind.routine() {
			log.Debug("stream ended", fields...)
			return
		}
		if kind == proxyErrShutdown {
			// Expected during a rollout, but still this server dropping somebody's in-flight request.
			log.Warn("request cancelled by shutdown", fields...)
			return
		}

		if retry && !tw.wrote {
			// The owner IP was unreachable before any bytes flowed, so serve via the fallback with retry=false.
			log.Warn("upstream unreachable, retrying via fallback",
				append(fields, slog.String("fallback", fallback.Host),
					slog.Bool("dial_failure", isDialFailure(e)))...)
			serveVia(shutdownCtx, ww, rr, fallback, fallback, false, convID)
			return
		}
		// A genuine proxy failure with no retry left.
		log.Error("proxy failed",
			append(fields, slog.Bool("response_started", tw.wrote),
				slog.Bool("dial_failure", isDialFailure(e)))...)
		if tw.wrote {
			// Headers already went out, so a 502 now would be a protocol violation.
			return
		}
		http.Error(ww, "upstream unavailable", http.StatusBadGateway)
	}
	proxy.ServeHTTP(tw, r)
}

// trackingWriter records whether any response byte or header has been written, so the dial-fail retry only fires while the client response is untouched.
type trackingWriter struct {
	http.ResponseWriter
	wrote bool
}

func (t *trackingWriter) WriteHeader(code int) { t.wrote = true; t.ResponseWriter.WriteHeader(code) }
func (t *trackingWriter) Write(b []byte) (int, error) {
	t.wrote = true
	return t.ResponseWriter.Write(b)
}

// Flush lets SSE streaming pass through the tracking wrapper.
func (t *trackingWriter) Flush() {
	if f, ok := t.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Hijack lets WebSocket upgrades pass through and marks the response as written, since a hijack takes over the conn.
func (t *trackingWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := t.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}
	t.wrote = true
	return h.Hijack()
}

// ownerResolver maps a conversation to its pod IP.
type ownerResolver interface {
	Resolve(ctx context.Context, id string) (ip, convID string, found bool, err error)
	Assigned(ctx context.Context, id string) bool
}

// resolveTargetFor returns a request's conversation id and upstream.
func resolveTargetFor(cfg config, resolver ownerResolver, r *http.Request, fallback *url.URL) (string, *url.URL, error) {
	if IsNonScoped(r.URL.Path) {
		return "", fallback, nil
	}
	convID := ""
	if IsAguiPost(r.Method, r.URL.Path) {
		convID = aguiThreadID(r) // reads and restores the body
	} else if id, ok := ConvIDFromPath(r.URL.Path); ok {
		convID = id
	}
	if convID == "" || resolver == nil {
		return convID, fallback, nil
	}
	ip, resolved, found, err := resolver.Resolve(r.Context(), convID)
	if errors.Is(err, ErrNoPods) {
		return convID, nil, err
	}
	if err != nil {
		// Reads still work; the fence refuses unassigned writes.
		logger("route").Warn("assignment lookup failed, using the Service", convAttr(convID), errAttr(err))
		return convID, fallback, nil
	}
	if !found {
		// No such conversation; let agent-host answer.
		return convID, fallback, nil
	}
	return resolved, TargetURL(ip, cfg.upstreamPort), nil
}

// aguiThreadID reads threadId from the POST /agui JSON body, then restores the body so the proxy forwards it unconsumed.
func aguiThreadID(r *http.Request) string {
	if r.Body == nil {
		return ""
	}
	buf, err := io.ReadAll(r.Body)
	_ = r.Body.Close()
	if err != nil {
		return ""
	}
	r.Body = io.NopCloser(bytes.NewReader(buf)) // restore for the upstream
	r.ContentLength = int64(len(buf))
	var body struct {
		ThreadID string `json:"threadId"`
	}
	_ = json.Unmarshal(buf, &body)
	return body.ThreadID
}

// buildTrustedCaller wires the TokenReview verifier that lets webhooks/scheduler set a conversation `owner` in the create body; every failure path warns and returns nil.
func buildTrustedCaller(kubeCfg *rest.Config, log *slog.Logger) TrustedCaller {
	allowed := trustedServiceAccounts()
	if len(allowed) == 0 {
		log.Warn("WEBHOOKS_SERVICE_ACCOUNT unset: an owner resolved by webhooks/scheduler cannot be honored")
		return nil
	}
	review, err := newTokenReviewer(kubeCfg, env("WEBHOOKS_TOKEN_AUDIENCE", "agent-host"))
	if err != nil {
		log.Warn("TokenReview client init failed: webhook-resolved conversation owners will be dropped", errAttr(err))
		return nil
	}
	log.Info("body-owner trust enabled", slog.Int("trusted_service_accounts", len(allowed)))
	return newTrustedCaller(review, allowed)
}

// --- k8s client + unstructured helpers (used by cache.go) -------------------

// kubeRestConfig resolves the apiserver credentials shared by the dynamic client and the TokenReview verifier.
func kubeRestConfig() (*rest.Config, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return clientcmd.BuildConfigFromFlags("", clientcmd.RecommendedHomeFile)
	}
	return cfg, nil
}

func newDynamicClient() (dynamic.Interface, *rest.Config, error) {
	cfg, err := kubeRestConfig()
	if err != nil {
		return nil, nil, err
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, nil, err
	}
	return dyn, cfg, nil
}

func metav1ListOptions() metav1.ListOptions { return metav1.ListOptions{} }
func metav1WatchOptions(rv string) metav1.ListOptions {
	return metav1.ListOptions{ResourceVersion: rv, Watch: true}
}
func unstructuredNestedString(obj map[string]interface{}, fields ...string) (string, bool, error) {
	return unstructured.NestedString(obj, fields...)
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
func atoi(s string) int { n, _ := strconv.Atoi(s); return n }

// isSSE reports whether the caller asked for the event stream rather than the JSON list.
func isSSE(r *http.Request) bool {
	return strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/event-stream") ||
		strings.HasSuffix(r.URL.Path, "/events")
}
