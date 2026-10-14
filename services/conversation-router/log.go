// Structured logging for the conversation-router, mirroring services/agent-host/src/log.ts
// so a single Loki query can follow one conversation across both services. One JSON object
// per line:
//
//	{"ts":"…","level":"info","service":"conversation-router","component":"proxy",
//	 "msg":"proxy failed","conversation_id":"42bb375c-…","upstream":"10.42.0.2:8080"}
//
// `msg` is a short constant and every variable value is a field; the conversation id field
// is always spelled `conversation_id` and passed explicitly where the router knows it.
package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"strings"
	"syscall"
)

// serviceName rides every line for cross-service queries to filter on.
const serviceName = "conversation-router"

// logLevel reads LOG_LEVEL with the same spellings the agent-host honors, defaulting to info.
func logLevel() slog.Level {
	switch strings.ToLower(os.Getenv("LOG_LEVEL")) {
	case "debug":
		return slog.LevelDebug
	case "info":
		return slog.LevelInfo
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	}
	if os.Getenv("DEBUG") == "1" {
		return slog.LevelDebug
	}
	return slog.LevelInfo
}

// jsonOutput picks JSON in a pod (KUBERNETES_SERVICE_HOST set) and text at a terminal, with LOG_FORMAT=json|pretty overriding.
func jsonOutput() bool {
	switch strings.ToLower(os.Getenv("LOG_FORMAT")) {
	case "json":
		return true
	case "pretty", "text":
		return false
	}
	return os.Getenv("KUBERNETES_SERVICE_HOST") != ""
}

// newHandler builds the slog handler writing to w.
func newHandler(w io.Writer) slog.Handler {
	opts := &slog.HandlerOptions{
		Level: logLevel(),
		// Rename slog's built-ins to the shared convention: "time" -> "ts", "message" -> "msg".
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			if len(groups) > 0 {
				return a
			}
			switch a.Key {
			case slog.TimeKey:
				a.Key = "ts"
			case slog.MessageKey:
				a.Key = "msg"
			case slog.LevelKey:
				// The fleet convention is lowercase levels, matching the TypeScript and Python services.
				if lv, ok := a.Value.Any().(slog.Level); ok {
					a.Value = slog.StringValue(strings.ToLower(lv.String()))
				}
			}
			return a
		},
	}
	if jsonOutput() {
		return slog.NewJSONHandler(w, opts)
	}
	return slog.NewTextHandler(w, opts)
}

// setupLogging installs the process-wide logger.
func setupLogging() {
	slog.SetDefault(slog.New(newHandler(os.Stderr)).With(slog.String("service", serviceName)))
}

// logger returns a logger bound to one component.
//
//	log := logger("cache")
//	log.Error("watch failed", errAttr(err))
func logger(component string) *slog.Logger {
	return slog.Default().With(slog.String("component", component))
}

// convAttr is the one spelling of the conversation id field; an empty id yields an empty Attr, which slog drops.
func convAttr(id string) slog.Attr {
	if id == "" {
		return slog.Attr{}
	}
	return slog.String("conversation_id", id)
}

// errAttr renders an error as a group carrying its type, errno and unwrap chain, so a failure is attributable without grepping the message.
func errAttr(err error) slog.Attr {
	if err == nil {
		return slog.Attr{}
	}
	attrs := []any{slog.String("message", err.Error())}

	// The concrete type distinguishes a connection refused from a deadline without parsing the message.
	if t := errType(err); t != "" {
		attrs = append(attrs, slog.String("type", t))
	}
	// A syscall errno is the useful discriminator for an unreachable pod, buried two Unwraps deep in a net error.
	var errno syscall.Errno
	if errors.As(err, &errno) {
		attrs = append(attrs, slog.String("errno", errno.Error()))
	}
	if u := errors.Unwrap(err); u != nil {
		attrs = append(attrs, slog.String("cause", u.Error()))
	}
	return slog.Group("error", attrs...)
}

func errType(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "context.Canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "context.DeadlineExceeded"
	case errors.Is(err, io.EOF):
		return "io.EOF"
	case errors.Is(err, io.ErrUnexpectedEOF):
		return "io.ErrUnexpectedEOF"
	}
	return ""
}
