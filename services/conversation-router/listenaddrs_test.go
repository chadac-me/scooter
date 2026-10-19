package main

import (
	"strings"
	"testing"
)

func TestDefaultListenAddrsDistinct(t *testing.T) {
	t.Setenv("SANDBOX_DOMAIN", "sandbox.example.com")
	t.Setenv("SELF_LISTEN_ADDR", ":8081")
	t.Setenv("SANDBOX_LISTEN_ADDR", "")
	cfg := configFromEnv()
	if err := validateListenAddrs(cfg); err != nil {
		t.Fatalf("defaults with self-access + sandbox domain collide: %v", err)
	}
}

func TestValidateListenAddrsCollision(t *testing.T) {
	cases := []struct {
		name string
		cfg  config
		want string
	}{
		{"self vs sandbox", config{listenAddr: ":8080", selfListenAddr: ":8081", sandboxDomain: "d", sandboxListenAddr: "0.0.0.0:8081"}, "SELF_LISTEN_ADDR and SANDBOX_LISTEN_ADDR"},
		{"main vs self", config{listenAddr: ":8080", selfListenAddr: ":8080"}, "LISTEN_ADDR and SELF_LISTEN_ADDR"},
	}
	for _, c := range cases {
		err := validateListenAddrs(c.cfg)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: got %v, want error mentioning %q", c.name, err, c.want)
		}
	}
	// Sandbox listener off: its address is irrelevant.
	if err := validateListenAddrs(config{listenAddr: ":8080", selfListenAddr: ":8081", sandboxListenAddr: ":8081"}); err != nil {
		t.Errorf("disabled sandbox listener flagged: %v", err)
	}
}
