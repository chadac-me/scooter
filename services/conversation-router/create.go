package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic"
)

// Creating a conversation is a control-plane write that consults no agent-host, so it
// succeeds even when the fleet is at capacity and the conversation is Pending until assigned.

// NewConversation is the conversation to persist: the CR spec, plus create-time metadata that is not part of the CR.
type NewConversation struct {
	Name string
	Spec map[string]interface{}
	// Title is create-time row metadata, not a CR field, and is dropped in cluster.
	Title string
}

// ConversationCreator creates a Conversation CR.
type ConversationCreator interface {
	Create(ctx context.Context, c NewConversation) error
}

// dynamicCreator uses the same dynamic client as the ownership cache.
type dynamicCreator struct {
	dyn       dynamic.Interface
	namespace string
}

func (d *dynamicCreator) Create(ctx context.Context, c NewConversation) error {
	// c.Title is not in the CRD schema and is not written.
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": conversationGVR.Group + "/" + conversationGVR.Version,
		"kind":       "Conversation",
		"metadata":   map[string]interface{}{"name": c.Name, "namespace": d.namespace},
		"spec":       c.Spec,
	}}
	_, err := d.dyn.Resource(conversationGVR).Namespace(d.namespace).Create(ctx, obj, metav1.CreateOptions{})
	return err
}

// Remove rolls the CR back; already-gone is success.
func (d *dynamicCreator) Remove(ctx context.Context, name string) error {
	err := d.dyn.Resource(conversationGVR).Namespace(d.namespace).Delete(ctx, name, metav1.DeleteOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}

// conversationRowWriter is the row half of dualCreator, kept narrow so which failure is fatal is testable without a Postgres.
type conversationRowWriter interface {
	CreateConversation(ctx context.Context, c NewConversation) error
}

// crRemover rolls back the CR; optional, so some creators cannot.
type crRemover interface {
	Remove(ctx context.Context, name string) error
}

// dualCreator writes both the Conversation CR and the `conversations` row on create, so the row can be the source of truth for existence.
type dualCreator struct {
	cr   ConversationCreator
	rows conversationRowWriter
}

func (d *dualCreator) Create(ctx context.Context, c NewConversation) error {
	if err := d.cr.Create(ctx, c); err != nil {
		return err
	}
	if err := d.rows.CreateConversation(ctx, c); err != nil {
		log := logger("create")
		remover, ok := d.cr.(crRemover)
		if ok {
			// Not the request's context, which may itself be the cancellation.
			rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			defer cancel()
			if rerr := remover.Remove(rctx, c.Name); rerr != nil {
				log.Error("conversation row insert failed AND the CR rollback failed; a CR with no row is left behind",
					errAttr(rerr), slog.String("conversation_id", c.Name), slog.String("row_error", err.Error()))
				return fmt.Errorf("could not write the conversation row: %w", err)
			}
		}
		log.Error("conversation row insert failed; the create is refused",
			errAttr(err), slog.String("conversation_id", c.Name), slog.Bool("cr_rolled_back", ok))
		return fmt.Errorf("could not write the conversation row: %w", err)
	}
	return nil
}

// createRequest is the accepted body; the server mints the id.
type createRequest struct {
	Title    string `json:"title"`
	Model    string `json:"model"`
	ParentID string `json:"parentId"`
	// Owner is honored only for a TokenReview-verified in-cluster caller (see trustedcaller.go) and ignored from anyone else.
	Owner string `json:"owner"`
}

type createResponse struct {
	// The conversation id, which is also the thread id.
	ID        string `json:"id"`
	Status    string `json:"status"`
	Title     string `json:"title"`
	CreatedAt int64  `json:"createdAt"`
	Owner     string `json:"owner,omitempty"`
}

// IsConversationCreate reports whether to handle here rather than proxy.
func IsConversationCreate(method, path string) bool {
	return method == http.MethodPost && strings.TrimSuffix(path, "/") == "/conversations"
}

// modelRe guards the only client-controlled string that reaches the CR spec.
var modelRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// serveConversationCreate returns 201 without waiting for assignment; `owner` is the ingress-resolved caller, and a body `owner` from a `trusted` in-cluster caller wins over it.
func serveConversationCreate(w http.ResponseWriter, r *http.Request, creator ConversationCreator, owner string, trusted TrustedCaller) {
	var req createRequest
	if r.Body != nil {
		dec := json.NewDecoder(r.Body)
		if err := dec.Decode(&req); err != nil && err.Error() != "EOF" {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
	}

	if req.Model != "" && !modelRe.MatchString(req.Model) {
		writeJSONError(w, http.StatusBadRequest, "invalid model")
		return
	}

	if req.Owner != "" && req.Owner != owner {
		// Verify only when it would change the outcome, so a browser create never pays the TokenReview round-trip.
		if trusted != nil && trusted(r.Context(), r) {
			owner = req.Owner
		} else {
			logger("create").Warn("ignored a body owner from an unverified caller",
				slog.Bool("had_header_owner", owner != ""))
		}
	}

	id := uuid.NewString()
	spec := map[string]interface{}{}
	if owner != "" {
		spec["owner"] = owner
	}
	if req.Model != "" {
		spec["model"] = req.Model
	}
	if req.ParentID != "" {
		spec["parentId"] = req.ParentID
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	// The title rides alongside the spec because the CR has no field for it.
	if err := creator.Create(ctx, NewConversation{Name: id, Spec: spec, Title: req.Title}); err != nil {
		logger("create").Error("conversation create failed",
			convAttr(id),
			slog.String("owner", owner),
			errAttr(err))
		writeJSONError(w, http.StatusBadGateway, fmt.Sprintf("could not create conversation: %v", err))
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(createResponse{
		ID:        id,
		Status:    "pending",
		Title:     req.Title,
		CreatedAt: time.Now().UnixMilli(),
		Owner:     owner,
	})
}

func writeJSONError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
