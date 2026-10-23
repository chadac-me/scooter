package main

import (
	"log/slog"
	"net/http"
	"net/url"
	"time"
)

// aguiRecorder counts what went back to the client on a POST /agui, so the "agui routed"
// line can tell a stream that carried events from one that committed a 200 and then sent
// nothing (the silently-dropped prompt the e2e interrupt flakes show).
type aguiRecorder struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (a *aguiRecorder) WriteHeader(code int) {
	if a.status == 0 {
		a.status = code
	}
	a.ResponseWriter.WriteHeader(code)
}

func (a *aguiRecorder) Write(b []byte) (int, error) {
	if a.status == 0 {
		a.status = http.StatusOK
	}
	n, err := a.ResponseWriter.Write(b)
	a.bytes += int64(n)
	return n, err
}

// Flush keeps SSE streaming immediate through the wrapper.
func (a *aguiRecorder) Flush() {
	if f, ok := a.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// serveAguiLogged proxies a POST /agui like serveVia, then logs one info line naming the
// upstream it was sent to, whether that was the recorded owner or the Service fallback,
// and what came back. Without it a prompt that lands on a pod and never runs leaves no
// trace of which pod took it.
func serveAguiLogged(serve func(w http.ResponseWriter), w http.ResponseWriter, convID string, target, fallback *url.URL) {
	start := time.Now()
	rec := &aguiRecorder{ResponseWriter: w}
	via := "owner"
	if target.Host == fallback.Host {
		via = "fallback"
	}
	serve(rec)
	logger("proxy").Info("agui routed",
		convAttr(convID),
		slog.String("upstream", target.Host),
		slog.String("via", via),
		slog.Int("status", rec.status),
		slog.Int64("bytes", rec.bytes),
		slog.Int64("duration_ms", time.Since(start).Milliseconds()),
	)
}
