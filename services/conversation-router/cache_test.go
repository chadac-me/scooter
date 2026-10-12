package main

import (
	"net/http/httptest"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// convCR builds a Conversation CR as the controller writes it: the thread UUID name, a `conv-<shortId>` sandboxRef and the owner pod's hostIP.
func convCR(name, sandboxRef, hostIP string) *unstructured.Unstructured {
	o := map[string]interface{}{
		"metadata": map[string]interface{}{"name": name},
		"spec":     map[string]interface{}{},
		"status":   map[string]interface{}{},
	}
	if sandboxRef != "" {
		o["spec"].(map[string]interface{})["sandboxRef"] = sandboxRef
	}
	if hostIP != "" {
		o["status"].(map[string]interface{})["hostIP"] = hostIP
	}
	return &unstructured.Unstructured{Object: o}
}

// The broker addresses conversations by the sandbox short-id, so both ids must resolve to the same owner.
func TestHostFromIndexesShortIDAndUUID(t *testing.T) {
	c := NewOwnershipCache()
	c.observe(convCR("5e1949ce-1111-2222-3333-444455556666", "conv-2j8rsf", "10.42.0.7"))

	if ip, ok := c.HostIP("5e1949ce-1111-2222-3333-444455556666"); !ok || ip != "10.42.0.7" {
		t.Errorf("UUID lookup = (%q,%v), want (10.42.0.7,true)", ip, ok)
	}
	if ip, ok := c.HostIP("2j8rsf"); !ok || ip != "10.42.0.7" {
		t.Errorf("short-id lookup = (%q,%v), want (10.42.0.7,true)", ip, ok)
	}
}

// A CR whose sandboxRef is not set yet must not panic and must not index a bogus alias.
func TestHostFromWithoutSandboxRef(t *testing.T) {
	c := NewOwnershipCache()
	c.observe(convCR("uuid-no-ref", "", "10.42.0.8"))

	if ip, ok := c.HostIP("uuid-no-ref"); !ok || ip != "10.42.0.8" {
		t.Errorf("UUID lookup = (%q,%v), want (10.42.0.8,true)", ip, ok)
	}
	if _, ok := c.HostIP(""); ok {
		t.Error("an empty key must never be indexed")
	}
	// A sandboxRef without the `conv-` prefix is not a short-id.
	c.observe(convCR("uuid-odd-ref", "something-else", "10.42.0.9"))
	if _, ok := c.HostIP("something-else"); ok {
		t.Error("a non conv- prefixed sandboxRef must not be indexed as a short-id")
	}
	if _, ok := c.HostIP("conv-"); ok {
		t.Error("a bare conv- prefix must not be indexed")
	}
}

// Eviction must clear both keys, since a stale alias routes to a dead pod.
func TestForgetClearsBothKeys(t *testing.T) {
	c := NewOwnershipCache()
	cr := convCR("uuid-gone", "conv-abc123", "10.42.0.7")
	c.observe(cr)
	c.forget(cr)

	if _, ok := c.HostIP("uuid-gone"); ok {
		t.Error("DELETED must clear the UUID key")
	}
	if _, ok := c.HostIP("abc123"); ok {
		t.Error("DELETED must clear the short-id key (a stale alias routes to a dead pod)")
	}
	// The alias must be gone from the map, not merely dangling.
	c.mu.RLock()
	_, leaked := c.aliases["abc123"]
	c.mu.RUnlock()
	if leaked {
		t.Error("DELETED left the short-id alias in the map (it must be swept, not just dangling)")
	}
}

// A DELETE event whose payload carries only metadata must still sweep the alias.
func TestForgetWithoutSpecStillSweepsAlias(t *testing.T) {
	c := NewOwnershipCache()
	c.observe(convCR("uuid-gone", "conv-abc123", "10.42.0.7"))
	c.forget(convCR("uuid-gone", "", "")) // tombstone: name only

	c.mu.RLock()
	_, leaked := c.aliases["abc123"]
	c.mu.RUnlock()
	if leaked {
		t.Error("a spec-less DELETE payload must still sweep the short-id alias")
	}
}

// Unassignment (status.hostIP cleared while the CR lives on) must clear both keys too.
func TestUnassignClearsBothKeys(t *testing.T) {
	c := NewOwnershipCache()
	c.observe(convCR("uuid-x", "conv-zzz999", "10.42.0.7"))
	c.observe(convCR("uuid-x", "conv-zzz999", "")) // controller cleared the owner

	if _, ok := c.HostIP("uuid-x"); ok {
		t.Error("an empty hostIP must unassign the UUID key")
	}
	if _, ok := c.HostIP("zzz999"); ok {
		t.Error("an empty hostIP must unassign the short-id key")
	}
	c.mu.RLock()
	_, leaked := c.aliases["zzz999"]
	c.mu.RUnlock()
	if leaked {
		t.Error("unassignment left the short-id alias in the map")
	}
}

// The broker's short-id-addressed notify must reach the owner pod, not the fallback.
func TestResolveTargetByShortID(t *testing.T) {
	cfg := config{namespace: "agent-sandbox", upstreamPort: 8080, clusterIPService: "agent-host"}
	fallback := FallbackURL(cfg.clusterIPService, cfg.namespace, cfg.upstreamPort)
	c := NewOwnershipCache()
	c.observe(convCR("5e1949ce-1111-2222-3333-444455556666", "conv-2j8rsf", "10.42.0.7"))

	// What the broker's _notify_host POSTs.
	r := httptest.NewRequest("POST", "/conversations/2j8rsf/aws-request", nil)
	if u := resolveTarget(cfg, c, r, fallback); u.String() != "http://10.42.0.7:8080" {
		t.Errorf("short-id aws-request -> %q, want the owner http://10.42.0.7:8080", u.String())
	}
	// The UUID path (UI/webhooks) must still resolve to the same owner.
	r = httptest.NewRequest("GET", "/conversations/5e1949ce-1111-2222-3333-444455556666/events.integrity", nil)
	if u := resolveTarget(cfg, c, r, fallback); u.String() != "http://10.42.0.7:8080" {
		t.Errorf("uuid path -> %q, want the owner http://10.42.0.7:8080", u.String())
	}
}
