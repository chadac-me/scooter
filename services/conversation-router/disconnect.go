package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"syscall"
)

// Classifying why a proxied request ended. httputil.ReverseProxy calls its ErrorHandler
// both for a genuinely broken upstream and for a stream that ended normally (a client
// navigating away, a finished body), which it surfaces as context.Canceled or io.EOF.
// context.Canceled alone does not say who cancelled: the per-request context is cancelled
// when the client's connection drops, the process shutdown context when this server is
// terminating, and during shutdown both are cancelled, so the shutdown context is checked
// first.

// proxyErrorKind is why a proxied request ended.
type proxyErrorKind int

const (
	// proxyErrUpstream is a genuine proxy failure the client gets a 502 for.
	proxyErrUpstream proxyErrorKind = iota
	// proxyErrClientGone means the client went away, which is routine.
	proxyErrClientGone
	// proxyErrStreamDone means the upstream body ended cleanly, which is routine.
	proxyErrStreamDone
	// proxyErrShutdown means this server is terminating and cancelled the in-flight request, which is reported at warn.
	proxyErrShutdown
)

// classifyProxyError decides why a proxied request ended, checking shutdownCtx before reqCtx because both are cancelled during shutdown.
func classifyProxyError(err error, shutdownCtx, reqCtx context.Context) proxyErrorKind {
	// A clean end of body is never a failure.
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return proxyErrStreamDone
	}

	if errors.Is(err, context.Canceled) {
		if shutdownCtx != nil && shutdownCtx.Err() != nil {
			return proxyErrShutdown
		}
		if reqCtx != nil && reqCtx.Err() != nil {
			return proxyErrClientGone
		}
		// A cancellation from deeper in the stack, with neither held context done, is not an upstream failure.
		return proxyErrClientGone
	}

	// A reset or broken pipe on the write side means the reader left, and ErrAbortHandler is what a hijacked handler panics with.
	if errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE) ||
		errors.Is(err, http.ErrAbortHandler) {
		return proxyErrClientGone
	}

	// Anything else, including a dial failure and a deadline, is a real failure.
	return proxyErrUpstream
}

// routine reports whether this ending needs no operator attention and no 502.
func (k proxyErrorKind) routine() bool {
	return k == proxyErrClientGone || k == proxyErrStreamDone
}

// String is the `reason` log field, one stable token per kind.
func (k proxyErrorKind) String() string {
	switch k {
	case proxyErrClientGone:
		return "client_disconnected"
	case proxyErrStreamDone:
		return "stream_finished"
	case proxyErrShutdown:
		return "server_shutdown"
	}
	return "upstream_failure"
}

// isDialFailure reports whether the upstream could not be reached at all, the case the fallback retry exists for.
func isDialFailure(err error) bool {
	var opErr *net.OpError
	if errors.As(err, &opErr) && opErr.Op == "dial" {
		return true
	}
	return errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.EHOSTUNREACH) ||
		errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, syscall.ETIMEDOUT)
}
