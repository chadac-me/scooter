// Ready agent-host pods, name -> IP, from a pod watch.
package main

import (
	"context"
	"log/slog"
	"sort"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

var podGVR = schema.GroupVersionResource{Version: "v1", Resource: "pods"}

var conversationGVR = schema.GroupVersionResource{
	Group:    "scooter.chadac.dev",
	Version:  "v1alpha1",
	Resource: "conversations",
}

// watchRetryDelay is the backoff after a failed list/watch.
const watchRetryDelay = 2 * time.Second

// agentHostSelector matches the controller's AGENT_HOST_LABEL.
const agentHostSelector = "app=agent-host"

// PodSet is the routable agent-host pods.
type PodSet interface {
	IP(name string) (string, bool)
	Ready() []string
}

// ReadyPods holds Ready, non-terminating pods with an IP.
type ReadyPods struct {
	mu  sync.RWMutex
	ips map[string]string
}

func NewReadyPods() *ReadyPods { return &ReadyPods{ips: map[string]string{}} }

func (p *ReadyPods) IP(name string) (string, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	ip, ok := p.ips[name]
	return ip, ok
}

// Ready returns the routable pod names, sorted for stable tie-breaks.
func (p *ReadyPods) Ready() []string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := make([]string, 0, len(p.ips))
	for n := range p.ips {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

func (p *ReadyPods) observe(obj *unstructured.Unstructured) {
	name, ip, ok := routable(obj)
	p.mu.Lock()
	defer p.mu.Unlock()
	if ok {
		p.ips[name] = ip
	} else {
		delete(p.ips, name)
	}
}

func (p *ReadyPods) forget(obj *unstructured.Unstructured) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.ips, obj.GetName())
}

func (p *ReadyPods) replace(items []unstructured.Unstructured) {
	next := map[string]string{}
	for i := range items {
		if name, ip, ok := routable(&items[i]); ok {
			next[name] = ip
		}
	}
	p.mu.Lock()
	p.ips = next
	p.mu.Unlock()
}

// routable: Ready, not terminating, with an IP.
func routable(obj *unstructured.Unstructured) (name, ip string, ok bool) {
	name = obj.GetName()
	if obj.GetDeletionTimestamp() != nil {
		return name, "", false
	}
	ip, _, _ = unstructured.NestedString(obj.Object, "status", "podIP")
	if ip == "" {
		return name, "", false
	}
	conds, _, _ := unstructured.NestedSlice(obj.Object, "status", "conditions")
	for _, c := range conds {
		m, _ := c.(map[string]interface{})
		if m["type"] == "Ready" && m["status"] == "True" {
			return name, ip, true
		}
	}
	return name, "", false
}

// Run lists then watches agent-host pods until ctx is cancelled.
func (p *ReadyPods) Run(ctx context.Context, dyn dynamic.Interface, namespace string) {
	log := logger("pods")
	ri := dyn.Resource(podGVR).Namespace(namespace)
	for ctx.Err() == nil {
		opts := metav1ListOptions()
		opts.LabelSelector = agentHostSelector
		list, err := ri.List(ctx, opts)
		if err != nil {
			if ctx.Err() == nil {
				log.Error("pod list failed", errAttr(err))
				sleep(ctx, watchRetryDelay)
			}
			continue
		}
		p.replace(list.Items)
		wopts := metav1WatchOptions(list.GetResourceVersion())
		wopts.LabelSelector = agentHostSelector
		w, err := ri.Watch(ctx, wopts)
		if err != nil {
			if ctx.Err() == nil {
				log.Error("pod watch failed", errAttr(err))
				sleep(ctx, watchRetryDelay)
			}
			continue
		}
		for ev := range w.ResultChan() {
			obj, ok := ev.Object.(*unstructured.Unstructured)
			if !ok {
				continue
			}
			if ev.Type == "DELETED" {
				p.forget(obj)
			} else {
				p.observe(obj)
			}
		}
		w.Stop()
		log.Debug("pod watch closed, re-listing", slog.Int("ready", len(p.Ready())))
	}
}
