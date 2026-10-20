// The direct path for sandbox hosts: the router carries a web service's bytes to the
// conversation's sandbox pod itself, instead of through the agent-host's Node proxy.
//
// The agent-host still decides everything: GET /internal/web-services/target on the
// owning agent-host answers the pod address, the service port, whether to strip the
// service prefix, the caller to stamp as x-scooter-user, and which inbound headers and
// session cookies to remove. The router caches that answer (ttlMs, 15s) and proxies
// HTTP and WebSockets straight to the pod.
//
// Anything the router cannot carry goes to the agent-host as before: a target answer
// other than 200 (the pod asleep, the service undeclared), the loading page's
// __scooter_status poll, and a GET the pod refused (the unit is down), where the
// agent-host starts the unit and serves the loading page. Traffic on the direct path is
// reported back (POST /internal/web-services/touch, at most once per 15s per
// conversation) so the idle-suspend sweep still sees it.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"
)

// DirectRouteHeader marks a response the router carried straight from the sandbox pod.
const DirectRouteHeader = "X-Scooter-Route"

// internalPrefix is the agent-host's cluster-internal web-service routes
// (services/agent-host/src/proxy/webServiceProxy.ts INTERNAL_PREFIX).
const internalPrefix = "/internal/web-services"

// statusSegment is the loading page's poll (webServiceProxy.ts STATUS_SEGMENT), always the agent-host's.
const statusSegment = "__scooter_status"

// handoff headers (identity.ts HANDOFF_USER_HEADER / HANDOFF_EMAIL_HEADER).
const (
	handoffUserHeader  = "X-Scooter-User"
	handoffEmailHeader = "X-Scooter-User-Email"
)

const (
	// directTouchInterval matches the agent-host proxy's TOUCH_THROTTLE_MS.
	directTouchInterval = 15 * time.Second
	// directMaxTTL caps the agent-host's ttlMs.
	directMaxTTL = time.Minute
	// directLookupTimeout bounds a target lookup; past it the request takes the agent-host path.
	directLookupTimeout = 5 * time.Second
	// directCacheMax bounds the cache; past it, expired entries are pruned.
	directCacheMax = 4096
)

// directTarget is the agent-host's GET /internal/web-services/target answer.
type directTarget struct {
	ConversationID string `json:"conversationId"`
	PodIP          string `json:"podIP"`
	Port           int    `json:"port"`
	StripBasePath  bool   `json:"stripBasePath"`
	User           *struct {
		ID    string `json:"id"`
		Email string `json:"email,omitempty"`
	} `json:"user,omitempty"`
	DropHeaders    []string `json:"dropHeaders"`
	SessionCookies []string `json:"sessionCookies"`
	TTLMs          int      `json:"ttlMs"`
}

type directEntry struct {
	target  *directTarget
	expires time.Time
}

type directCall struct {
	done   chan struct{}
	target *directTarget
}

// directProxy holds the target cache and the touch throttle.
type directProxy struct {
	client *http.Client
	now    func() time.Time
	// identityHeaders are the request headers the agent-host resolves the caller from, so
	// two callers never share an entry.
	identityHeaders []string

	mu       sync.Mutex
	cache    map[string]directEntry
	inflight map[string]*directCall
	touched  map[string]time.Time
}

func newDirectProxy() *directProxy {
	return &directProxy{
		client:          &http.Client{Timeout: directLookupTimeout},
		now:             time.Now,
		identityHeaders: identityHeadersFromEnv(),
		cache:           map[string]directEntry{},
		inflight:        map[string]*directCall{},
		touched:         map[string]time.Time{},
	}
}

// identityHeadersFromEnv: every header identity.ts may read the caller from, in either mode.
func identityHeadersFromEnv() []string {
	return []string{
		env("AUTH_USER_HEADER", "x-auth-user"),
		env("AUTH_EMAIL_HEADER", "x-auth-email"),
		env("AUTH_ALB_IDENTITY_HEADER", "x-amzn-oidc-identity"),
		env("AUTH_ALB_DATA_HEADER", "x-amzn-oidc-data"),
	}
}

func (d *directProxy) cacheKey(convID, service, label string, r *http.Request) string {
	h := sha256.New()
	for _, name := range d.identityHeaders {
		io.WriteString(h, strings.Join(r.Header.Values(name), ","))
		h.Write([]byte{0})
	}
	return convID + "\x00" + service + "\x00" + label + "\x00" + hex.EncodeToString(h.Sum(nil))
}

// lookup returns the pod target for a sandbox-host request, or nil when the agent-host
// must serve it. One lookup per key is in flight however many requests wait on it.
func (d *directProxy) lookup(ctx context.Context, owner, fallback *url.URL, convID, service, label string, r *http.Request) *directTarget {
	key := d.cacheKey(convID, service, label, r)
	d.mu.Lock()
	if e, ok := d.cache[key]; ok && d.now().Before(e.expires) {
		d.mu.Unlock()
		return e.target
	}
	if c, ok := d.inflight[key]; ok {
		d.mu.Unlock()
		select {
		case <-c.done:
			return c.target
		case <-ctx.Done():
			return nil
		}
	}
	c := &directCall{done: make(chan struct{})}
	d.inflight[key] = c
	d.mu.Unlock()

	t := d.fetch(ctx, owner, convID, service, label, r)
	if t == nil && fallback != nil && owner.Host != fallback.Host && ctx.Err() == nil {
		// A stale owner address; any agent-host can answer.
		t = d.fetch(ctx, fallback, convID, service, label, r)
	}

	d.mu.Lock()
	delete(d.inflight, key)
	if t != nil {
		ttl := time.Duration(t.TTLMs) * time.Millisecond
		if ttl <= 0 || ttl > directMaxTTL {
			ttl = directMaxTTL
		}
		if len(d.cache) >= directCacheMax {
			d.pruneLocked()
		}
		d.cache[key] = directEntry{target: t, expires: d.now().Add(ttl)}
		// The lookup itself counted as activity on the agent-host.
		d.touched[t.ConversationID] = d.now()
	}
	d.mu.Unlock()
	c.target = t
	close(c.done)
	return t
}

func (d *directProxy) pruneLocked() {
	now := d.now()
	for k, e := range d.cache {
		if !now.Before(e.expires) {
			delete(d.cache, k)
		}
	}
	if len(d.cache) >= directCacheMax {
		d.cache = map[string]directEntry{}
	}
	for k, at := range d.touched {
		if now.Sub(at) >= directTouchInterval {
			delete(d.touched, k)
		}
	}
}

// fetch asks one agent-host for the target; nil on any non-200 or failure.
func (d *directProxy) fetch(ctx context.Context, base *url.URL, convID, service, label string, r *http.Request) *directTarget {
	q := url.Values{"conversation": {convID}, "service": {service}, "label": {label}}
	u := *base
	u.Path = internalPrefix + "/target"
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil
	}
	for _, name := range d.identityHeaders {
		for _, v := range r.Header.Values(name) {
			req.Header.Add(name, v)
		}
	}
	res, err := d.client.Do(req)
	if err != nil {
		if ctx.Err() == nil {
			logger("direct").Warn("target lookup failed", convAttr(convID), slog.String("upstream", base.Host), errAttr(err))
		}
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
		return nil
	}
	var t directTarget
	if err := json.NewDecoder(io.LimitReader(res.Body, 64*1024)).Decode(&t); err != nil || t.PodIP == "" || t.Port <= 0 || t.Port > 65535 {
		logger("direct").Warn("target lookup returned an unusable answer", convAttr(convID), errAttr(err))
		return nil
	}
	return &t
}

// invalidate drops a conversation's cached targets after the pod refused or broke.
func (d *directProxy) invalidate(convID string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	prefix := convID + "\x00"
	for k := range d.cache {
		if strings.HasPrefix(k, prefix) {
			delete(d.cache, k)
		}
	}
}

// touch reports activity to the agent-host, at most once per directTouchInterval per conversation.
func (d *directProxy) touch(owner *url.URL, convID string) {
	d.mu.Lock()
	if d.now().Sub(d.touched[convID]) < directTouchInterval {
		d.mu.Unlock()
		return
	}
	d.touched[convID] = d.now()
	d.mu.Unlock()
	go func() {
		u := *owner
		u.Path = internalPrefix + "/touch"
		u.RawQuery = url.Values{"conversation": {convID}}.Encode()
		ctx, cancel := context.WithTimeout(context.Background(), directLookupTimeout)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), nil)
		if err != nil {
			return
		}
		res, err := d.client.Do(req)
		if err != nil {
			logger("direct").Debug("touch failed", convAttr(convID), errAttr(err))
			return
		}
		_, _ = io.Copy(io.Discard, res.Body)
		res.Body.Close()
	}()
}

// sandboxService splits a sandbox host's browser path (/<service>/rest, escaped) into the
// decoded service name and the escaped remainder ("/" when empty).
func sandboxService(escapedPath string) (service, rest string, ok bool) {
	p := strings.TrimPrefix(escapedPath, "/")
	seg, tail, found := strings.Cut(p, "/")
	if seg == "" {
		return "", "", false
	}
	name, err := url.PathUnescape(seg)
	if err != nil || name == "" {
		return "", "", false
	}
	if !found {
		return name, "/", true
	}
	return name, "/" + tail, true
}

// stripCookies removes the session cookies from a Cookie header; "" when nothing is left.
func stripCookies(values []string, prefixes []string) string {
	var kept []string
	for _, v := range values {
		for _, c := range strings.Split(v, ";") {
			c = strings.TrimSpace(c)
			if c == "" {
				continue
			}
			name, _, _ := strings.Cut(c, "=")
			if !hasAnyPrefix(strings.TrimSpace(name), prefixes) {
				kept = append(kept, c)
			}
		}
	}
	return strings.Join(kept, "; ")
}

// stripSetCookies removes Set-Cookie values that would set the ingress session.
func stripSetCookies(h http.Header, prefixes []string) {
	values := h.Values("Set-Cookie")
	if len(values) == 0 {
		return
	}
	h.Del("Set-Cookie")
	for _, v := range values {
		name, _, _ := strings.Cut(v, "=")
		if !hasAnyPrefix(strings.TrimSpace(name), prefixes) {
			h.Add("Set-Cookie", v)
		}
	}
}

func hasAnyPrefix(s string, prefixes []string) bool {
	for _, p := range prefixes {
		if p != "" && strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

// touchingConn reports activity on every frame of an upgraded connection, in either direction.
type touchingConn struct {
	io.ReadWriteCloser
	touch func()
}

func (c touchingConn) Read(p []byte) (int, error) {
	n, err := c.ReadWriteCloser.Read(p)
	if n > 0 {
		c.touch()
	}
	return n, err
}

func (c touchingConn) Write(p []byte) (int, error) {
	if len(p) > 0 {
		c.touch()
	}
	return c.ReadWriteCloser.Write(p)
}

// serve proxies a sandbox-host request straight to the pod. browserPath is the escaped
// path the browser sent (/<service>/...), rest its remainder after the service.
// agentHost serves the request the old way when the pod refuses a body-less request.
func (d *directProxy) serve(shutdownCtx context.Context, w http.ResponseWriter, r *http.Request, t *directTarget, owner *url.URL, browserPath, rest string, agentHost func(http.ResponseWriter, *http.Request)) {
	log := logger("direct")
	started := d.now()
	convID := t.ConversationID
	touch := func() { d.touch(owner, convID) }
	touch()

	podPath := browserPath
	if t.StripBasePath {
		podPath = rest
	}
	podHost := t.PodIP + ":" + itoa(t.Port)
	tw := &trackingWriter{ResponseWriter: w}
	proxy := &httputil.ReverseProxy{
		FlushInterval: -1,
		Director: func(out *http.Request) {
			out.URL.Scheme = "http"
			out.URL.Host = podHost
			out.URL.RawPath = podPath
			if p, err := url.PathUnescape(podPath); err == nil {
				out.URL.Path = p
			} else {
				out.URL.Path = podPath
			}
			out.Host = podHost
			// Origin checks (code-server's WebSockets) need the public host, not podHost.
			// Set, not Add: r.Host routed this request, so a client-sent value must lose.
			out.Header.Set("X-Forwarded-Host", r.Host)
			out.Header.Del(SandboxHostHeader)
			for _, name := range t.DropHeaders {
				out.Header.Del(name)
			}
			out.Header.Del(handoffUserHeader)
			out.Header.Del(handoffEmailHeader)
			if cookie := stripCookies(out.Header.Values("Cookie"), t.SessionCookies); cookie != "" {
				out.Header.Set("Cookie", cookie)
			} else {
				out.Header.Del("Cookie")
			}
			if t.User != nil && t.User.ID != "" {
				out.Header.Set(handoffUserHeader, t.User.ID)
				if t.User.Email != "" {
					out.Header.Set(handoffEmailHeader, t.User.Email)
				}
			}
		},
		ModifyResponse: func(res *http.Response) error {
			// A pod must not set or overwrite the ingress session (fixation, forced logout).
			stripSetCookies(res.Header, t.SessionCookies)
			// Which path served the response, for debugging and the e2e that checks the
			// direct path is the one in use.
			res.Header.Set(DirectRouteHeader, "direct")
			if res.StatusCode == http.StatusSwitchingProtocols {
				if rwc, ok := res.Body.(io.ReadWriteCloser); ok {
					res.Body = touchingConn{ReadWriteCloser: rwc, touch: touch}
				}
			}
			elapsed := d.now().Sub(started)
			fields := []any{convAttr(convID), slog.String("method", r.Method), slog.Int("status", res.StatusCode), slog.Int64("total_ms", elapsed.Milliseconds())}
			if elapsed >= 250*time.Millisecond {
				log.Info("slow web-service request", fields...)
			} else {
				log.Debug("web-service request", fields...)
			}
			return nil
		},
		ErrorHandler: func(ww http.ResponseWriter, rr *http.Request, e error) {
			kind := classifyProxyError(e, shutdownCtx, rr.Context())
			if kind.routine() || kind == proxyErrShutdown {
				return
			}
			// The pod moved, or the unit is down: look again next time.
			d.invalidate(convID)
			if !tw.wrote && isDialFailure(e) && (rr.Method == http.MethodGet || rr.Method == http.MethodHead) {
				// Nothing listening: the agent-host starts the unit and shows the loading page.
				log.Debug("pod refused, serving via the agent-host", convAttr(convID), errAttr(e))
				// rr is the rewritten outbound copy; the agent-host gets the request as routed.
				agentHost(ww, r)
				return
			}
			log.Warn("direct proxy failed", convAttr(convID), slog.String("upstream", podHost), slog.String("reason", kind.String()), errAttr(e))
			if !tw.wrote {
				http.Error(ww, "upstream error", http.StatusBadGateway)
			}
		},
	}
	proxy.ServeHTTP(tw, r)
}
