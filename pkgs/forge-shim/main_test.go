package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// echoServer accepts connections and runs handle on each.
func echoServer(t *testing.T, handle func(net.Conn)) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go handle(c)
		}
	}()
	return ln.Addr().String()
}

type seen struct {
	target, auth string
}

// fakeBroker answers a CONNECT with `status`, records it, and then echoes upper-cased lines.
func fakeBroker(t *testing.T, status int, got chan<- seen) string {
	return echoServer(t, func(c net.Conn) {
		defer c.Close()
		br := bufio.NewReader(c)
		req, err := http.ReadRequest(br)
		if err != nil {
			return
		}
		got <- seen{req.Host, req.Header.Get("Proxy-Authorization")}
		if status != 200 {
			writeStatus(c, status, "denied by broker")
			return
		}
		io.WriteString(c, "HTTP/1.1 200 Connection Established\r\n\r\n")
		line, _ := br.ReadString('\n')
		io.WriteString(c, "BROKER:"+strings.ToUpper(line))
	})
}

func startShim(t *testing.T, s *shim) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go s.serve(ln)
	return ln.Addr().String()
}

func newShim(t *testing.T, broker string, dialRewrite map[string]string) *shim {
	dir := t.TempDir()
	tok := filepath.Join(dir, "token")
	hosts := filepath.Join(dir, "hosts")
	os.WriteFile(tok, []byte("sa-token-1\n"), 0o600)
	os.WriteFile(hosts, []byte("github.com\napi.github.com\n"), 0o644)
	return &shim{
		broker: broker, tokenPath: tok, hostsPath: hosts,
		dial: func(network, addr string) (net.Conn, error) {
			if r, ok := dialRewrite[addr]; ok {
				addr = r
			}
			return net.DialTimeout(network, addr, 5*time.Second)
		},
	}
}

func connect(t *testing.T, shimAddr, target string) (net.Conn, *bufio.Reader, *http.Response) {
	t.Helper()
	c, err := net.Dial("tcp", shimAddr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	fmt.Fprintf(c, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatal(err)
	}
	return c, br, resp
}

func TestForgeHostGoesToBrokerWithToken(t *testing.T) {
	got := make(chan seen, 1)
	s := newShim(t, fakeBroker(t, 200, got), nil)
	addr := startShim(t, s)

	c, br, resp := connect(t, addr, "github.com:443")
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	g := <-got
	if g.target != "github.com:443" || g.auth != "Bearer sa-token-1" {
		t.Fatalf("broker saw %+v", g)
	}
	io.WriteString(c, "hello\n")
	line, _ := br.ReadString('\n')
	if line != "BROKER:HELLO\n" {
		t.Fatalf("got %q", line)
	}
}

func TestTokenIsReReadPerConnection(t *testing.T) {
	got := make(chan seen, 2)
	s := newShim(t, fakeBroker(t, 200, got), nil)
	addr := startShim(t, s)
	connect(t, addr, "api.github.com:443")
	<-got
	os.WriteFile(s.tokenPath, []byte("sa-token-2"), 0o600)
	connect(t, addr, "api.github.com:443")
	if g := <-got; g.auth != "Bearer sa-token-2" {
		t.Fatalf("rotated token not used: %+v", g)
	}
}

func TestNonForgeHostIsTunnelledDirectly(t *testing.T) {
	got := make(chan seen, 1)
	direct := echoServer(t, func(c net.Conn) {
		defer c.Close()
		line, _ := bufio.NewReader(c).ReadString('\n')
		io.WriteString(c, "DIRECT:"+line)
	})
	s := newShim(t, fakeBroker(t, 200, got), map[string]string{"example.org:443": direct})
	addr := startShim(t, s)

	c, br, resp := connect(t, addr, "example.org:443")
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	io.WriteString(c, "hi\n")
	if line, _ := br.ReadString('\n'); line != "DIRECT:hi\n" {
		t.Fatalf("got %q", line)
	}
	select {
	case g := <-got:
		t.Fatalf("non-forge host reached the broker: %+v", g)
	default:
	}
}

func TestForgeHostOnOtherPortIsDirect(t *testing.T) {
	got := make(chan seen, 1)
	direct := echoServer(t, func(c net.Conn) { c.Close() })
	s := newShim(t, fakeBroker(t, 200, got), map[string]string{"github.com:22": direct})
	_, _, resp := connect(t, startShim(t, s), "github.com:22")
	if resp.StatusCode != 200 || len(got) != 0 {
		t.Fatalf("status %d, broker calls %d", resp.StatusCode, len(got))
	}
}

func TestBrokerRefusalIsPassedThrough(t *testing.T) {
	got := make(chan seen, 1)
	s := newShim(t, fakeBroker(t, 407, got), nil)
	_, br, resp := connect(t, startShim(t, s), "github.com:443")
	if resp.StatusCode != 407 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(io.LimitReader(br, 100))
	if !strings.Contains(string(body), "denied by broker") {
		t.Fatalf("body %q", body)
	}
}

func TestNoHostsFileMeansEverythingDirect(t *testing.T) {
	got := make(chan seen, 1)
	direct := echoServer(t, func(c net.Conn) { c.Close() })
	s := newShim(t, fakeBroker(t, 200, got), map[string]string{"github.com:443": direct})
	os.Remove(s.hostsPath)
	_, _, resp := connect(t, startShim(t, s), "github.com:443")
	if resp.StatusCode != 200 || len(got) != 0 {
		t.Fatalf("status %d, broker calls %d", resp.StatusCode, len(got))
	}
}
