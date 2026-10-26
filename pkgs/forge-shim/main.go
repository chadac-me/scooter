// scooter-forge-shim: the sandbox's local HTTPS proxy (HTTPS_PROXY=http://127.0.0.1:3128).
//
// A CONNECT to a forge host (the hosts file the broker publishes) is relayed to
// the broker's forge proxy with the pod's projected SA token as
// Proxy-Authorization, re-read per connection because kubelet rotates it. The
// broker terminates TLS and injects the forge credential, so no token ever enters
// the sandbox. Every other CONNECT is tunnelled directly, keeping general egress
// off the broker.
package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type shim struct {
	broker    string // host:port of the broker's forge proxy; empty tunnels everything directly
	tokenPath string
	hostsPath string
	dial      func(network, addr string) (net.Conn, error)

	mu        sync.Mutex
	hosts     map[string]bool
	hostsMod  time.Time
	hostsSeen time.Time
}

func main() {
	listen := flag.String("listen", "127.0.0.1:3128", "address to listen on")
	broker := flag.String("broker", os.Getenv("FORGE_PROXY_ADDR"), "broker forge proxy host:port")
	tokenPath := flag.String("token", envOr("BROKER_TOKEN_PATH", "/var/run/secrets/broker/token"), "projected SA token")
	hostsPath := flag.String("hosts", "/etc/scooter/forge-ca/hosts", "forge hosts file, one per line")
	flag.Parse()

	s := &shim{
		broker:    *broker,
		tokenPath: *tokenPath,
		hostsPath: *hostsPath,
		dial: func(network, addr string) (net.Conn, error) {
			return net.DialTimeout(network, addr, 15*time.Second)
		},
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatalf("listen %s: %v", *listen, err)
	}
	log.Printf("forge shim on %s -> broker %q (hosts from %s)", *listen, *broker, *hostsPath)
	if err := s.serve(ln); err != nil {
		log.Fatal(err)
	}
}

func envOr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func (s *shim) serve(ln net.Listener) error {
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		go s.handle(c)
	}
}

// isForge reports whether host is intercepted, re-reading the kubelet-updated hosts file at most every few seconds.
func (s *shim) isForge(host string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if time.Since(s.hostsSeen) > 5*time.Second || s.hosts == nil {
		s.hostsSeen = time.Now()
		st, err := os.Stat(s.hostsPath)
		switch {
		case err != nil:
			s.hosts = map[string]bool{}
		case !st.ModTime().Equal(s.hostsMod) || s.hosts == nil:
			s.hostsMod = st.ModTime()
			s.hosts = map[string]bool{}
			if data, err := os.ReadFile(s.hostsPath); err == nil {
				for _, h := range strings.Fields(string(data)) {
					s.hosts[strings.ToLower(h)] = true
				}
			}
		}
	}
	return s.hosts[strings.ToLower(host)]
}

func (s *shim) handle(client net.Conn) {
	defer client.Close()
	_ = client.SetReadDeadline(time.Now().Add(30 * time.Second))
	br := bufio.NewReader(client)
	req, err := http.ReadRequest(br)
	if err != nil {
		return
	}
	_ = client.SetReadDeadline(time.Time{})

	if req.Method != http.MethodConnect {
		s.forwardPlain(client, req)
		return
	}
	host, port, err := net.SplitHostPort(req.Host)
	if err != nil {
		writeStatus(client, http.StatusBadRequest, "bad CONNECT target")
		return
	}
	if s.broker != "" && port == "443" && s.isForge(host) {
		s.viaBroker(client, br, req.Host)
		return
	}
	upstream, err := s.dial("tcp", req.Host)
	if err != nil {
		writeStatus(client, http.StatusBadGateway, err.Error())
		return
	}
	defer upstream.Close()
	if _, err := io.WriteString(client, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	pipe(client, br, upstream, nil)
}

// viaBroker relays a forge CONNECT to the broker with the SA token, then splices the two connections.
func (s *shim) viaBroker(client net.Conn, clientBuf *bufio.Reader, target string) {
	token, err := os.ReadFile(s.tokenPath)
	if err != nil {
		writeStatus(client, http.StatusBadGateway, "no broker token: "+err.Error())
		return
	}
	upstream, err := s.dial("tcp", s.broker)
	if err != nil {
		writeStatus(client, http.StatusBadGateway, "broker forge proxy unreachable: "+err.Error())
		return
	}
	defer upstream.Close()
	fmt.Fprintf(upstream, "CONNECT %s HTTP/1.1\r\nHost: %s\r\nProxy-Authorization: Bearer %s\r\n\r\n",
		target, target, strings.TrimSpace(string(token)))
	ubuf := bufio.NewReader(upstream)
	resp, err := http.ReadResponse(ubuf, &http.Request{Method: http.MethodConnect})
	if err != nil {
		writeStatus(client, http.StatusBadGateway, "broker forge proxy: "+err.Error())
		return
	}
	if resp.StatusCode != http.StatusOK {
		// Hand the broker's refusal (403 policy, 407 auth) back to the client verbatim.
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		writeStatus(client, resp.StatusCode, strings.TrimSpace(string(body)))
		return
	}
	if _, err := io.WriteString(client, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	pipe(client, clientBuf, upstream, ubuf)
}

// forwardPlain handles an absolute-form http:// request (a client with HTTP_PROXY set); forges are HTTPS-only, so it never goes to the broker.
func (s *shim) forwardPlain(client net.Conn, req *http.Request) {
	if req.URL.Scheme != "http" || req.URL.Host == "" {
		writeStatus(client, http.StatusBadRequest, "expected CONNECT or an absolute http:// URL")
		return
	}
	req.RequestURI = ""
	req.Header.Del("Proxy-Connection")
	req.Header.Del("Proxy-Authorization")
	req.Close = true
	tr := &http.Transport{Proxy: nil, Dial: s.dial, DisableKeepAlives: true}
	resp, err := tr.RoundTrip(req)
	if err != nil {
		writeStatus(client, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()
	resp.Close = true
	_ = resp.Write(client)
}

func writeStatus(w io.Writer, code int, msg string) {
	body := msg + "\n"
	fmt.Fprintf(w, "HTTP/1.1 %d %s\r\nContent-Type: text/plain\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s",
		code, http.StatusText(code), len(body), body)
}

// pipe copies both ways until either side closes; buffered readers carry bytes already read past the headers.
func pipe(client net.Conn, clientBuf *bufio.Reader, upstream net.Conn, upstreamBuf *bufio.Reader) {
	var fromClient io.Reader = client
	if clientBuf != nil {
		fromClient = clientBuf
	}
	var fromUpstream io.Reader = upstream
	if upstreamBuf != nil {
		fromUpstream = upstreamBuf
	}
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(upstream, fromClient)
		closeWrite(upstream)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(client, fromUpstream)
		closeWrite(client)
		done <- struct{}{}
	}()
	<-done
	<-done
}

func closeWrite(c net.Conn) {
	if tc, ok := c.(interface{ CloseWrite() error }); ok {
		_ = tc.CloseWrite()
	} else {
		_ = c.Close()
	}
}
