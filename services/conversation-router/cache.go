// The ownership cache: a conversationId -> owner pod IP map kept fresh by a dynamic k8s
// watch on the Conversation CRD.
package main

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

// watchRetryDelay is the backoff between a failed list/watch and the next attempt.
const watchRetryDelay = 2 * time.Second

var conversationGVR = schema.GroupVersionResource{
	Group:    "scooter.chadac.dev",
	Version:  "v1alpha1",
	Resource: "conversations",
}

// OwnershipCache maps conversationId -> owner pod IP (status.hostIP), updated from the CRD
// watch. A conversation has two id-spaces, the thread UUID (the CR name, used by the UI and
// webhooks) and the sandbox short-id (`conv-<shortId>` in spec.sandboxRef, all the broker
// knows), and both are indexed so either address resolves to the same owner.
type OwnershipCache struct {
	mu    sync.RWMutex
	hosts map[string]string // convID (thread UUID) -> hostIP
	// aliases maps short-id -> thread UUID, an indirection so an owner change updates one entry.
	aliases map[string]string
}

func NewOwnershipCache() *OwnershipCache {
	return &OwnershipCache{
		hosts:   map[string]string{},
		aliases: map[string]string{},
	}
}

// HostIP returns the assigned owner pod IP for a conversation, or ("", false) if unknown or unassigned.
func (c *OwnershipCache) HostIP(convID string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	h, ok := c.hosts[convID]
	if !ok {
		// Not a thread UUID, so try it as a sandbox short-id.
		if uuid, isAlias := c.aliases[convID]; isAlias {
			h, ok = c.hosts[uuid]
		}
	}
	return h, ok && h != ""
}

func (c *OwnershipCache) set(convID, host string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if host == "" {
		delete(c.hosts, convID)
	} else {
		c.hosts[convID] = host
	}
}

func (c *OwnershipCache) delete(convID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.hosts, convID)
}

// observe records an ADDED/MODIFIED Conversation: the owner IP under the thread UUID, plus the short-id alias.
func (c *OwnershipCache) observe(obj *unstructured.Unstructured) {
	convID, host := hostFrom(obj)
	if convID == "" {
		return
	}
	short := shortIDFrom(obj)
	c.mu.Lock()
	defer c.mu.Unlock()
	if host == "" {
		delete(c.hosts, convID)
	} else {
		c.hosts[convID] = host
	}
	if short == "" {
		return
	}
	if host == "" {
		// Unassigned, so drop the alias too so it cannot outlive the mapping it stands for.
		delete(c.aliases, short)
		return
	}
	c.aliases[short] = convID
}

// forget drops a DELETED Conversation from both indexes, since a stale alias would keep routing broker traffic to a dead pod.
func (c *OwnershipCache) forget(obj *unstructured.Unstructured) {
	convID, _ := hostFrom(obj)
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.hosts, convID)

	// Sweeping aliases by owner covers a DELETE event whose object arrives without spec.
	for alias, owner := range c.aliases {
		if owner == convID {
			delete(c.aliases, alias)
		}
	}
}

// Run keeps the cache in sync, listing to seed and then watching for changes, reconnecting on error until ctx is cancelled.
func (c *OwnershipCache) Run(ctx context.Context, dyn dynamic.Interface, namespace string) {
	log := logger("cache")
	ri := dyn.Resource(conversationGVR).Namespace(namespace)
	for ctx.Err() == nil {
		// Seed from a full list so routing is not blind before the first watch event.
		list, err := ri.List(ctx, metav1ListOptions())
		if err != nil {
			if ctx.Err() != nil {
				return // a cancelled list during shutdown is not a failure
			}
			log.Error("conversation list failed",
				slog.String("namespace", namespace),
				slog.Int("retry_in_ms", int(watchRetryDelay.Milliseconds())),
				errAttr(err))
			sleep(ctx, watchRetryDelay)
			continue
		}
		log.Debug("cache seeded",
			slog.String("namespace", namespace),
			slog.Int("conversations", len(list.Items)))
		for i := range list.Items {
			c.observe(&list.Items[i])
		}
		// Watch from the list's resourceVersion onward.
		w, err := ri.Watch(ctx, metav1WatchOptions(list.GetResourceVersion()))
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Error("conversation watch failed",
				slog.String("namespace", namespace),
				slog.Int("retry_in_ms", int(watchRetryDelay.Milliseconds())),
				errAttr(err))
			sleep(ctx, watchRetryDelay)
			continue
		}
		for ev := range w.ResultChan() {
			obj, ok := ev.Object.(*unstructured.Unstructured)
			if !ok {
				continue
			}
			switch ev.Type {
			case "DELETED":
				c.forget(obj)
			default: // ADDED, MODIFIED
				c.observe(obj)
			}
		}
		w.Stop()
		// The watch expired, which is routine, so loop to re-list and re-watch.
		log.Debug("watch channel closed, re-listing", slog.String("namespace", namespace))
	}
}

// hostFrom pulls (name, status.hostIP) from a Conversation object.
func hostFrom(obj *unstructured.Unstructured) (convID, hostIP string) {
	convID = obj.GetName()
	hostIP, _, _ = unstructuredNestedString(obj.Object, "status", "hostIP")
	return convID, hostIP
}

// shortIDFrom derives the sandbox short-id from spec.sandboxRef (`conv-<shortId>`), "" when the ref is absent or unprefixed.
func shortIDFrom(obj *unstructured.Unstructured) string {
	ref, _, _ := unstructuredNestedString(obj.Object, "spec", "sandboxRef")
	if !strings.HasPrefix(ref, "conv-") {
		return ""
	}
	return strings.TrimPrefix(ref, "conv-")
}
