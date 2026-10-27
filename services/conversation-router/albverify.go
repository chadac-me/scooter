package main

// Verifies ALB's ES256-signed x-amzn-oidc-data instead of trusting headers.

import (
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// albClockSkew tolerates small clock drift on the token's exp.
const albClockSkew = 30 * time.Second

var errAlbInvalid = errors.New("ALB OIDC token not valid")

type albVerifier struct {
	region string
	// fetch returns a kid's PEM public key; tests replace it.
	fetch func(ctx context.Context, kid string) ([]byte, error)
	now   func() time.Time

	mu   sync.Mutex
	keys map[string]*ecdsa.PublicKey
}

func newAlbVerifier(region string) *albVerifier {
	v := &albVerifier{region: region, now: time.Now, keys: map[string]*ecdsa.PublicKey{}}
	client := &http.Client{Timeout: sessionTimeout}
	v.fetch = func(ctx context.Context, kid string) ([]byte, error) {
		u := fmt.Sprintf("https://public-keys.auth.elb.%s.amazonaws.com/%s", v.region, url.PathEscape(kid))
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return nil, err
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("ALB key %s: status %d", kid, resp.StatusCode)
		}
		return io.ReadAll(io.LimitReader(resp.Body, 16<<10))
	}
	return v
}

// b64 decodes base64url with or without padding; ALB pads its segments.
func b64(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}

func (v *albVerifier) key(ctx context.Context, kid string) (*ecdsa.PublicKey, error) {
	v.mu.Lock()
	k := v.keys[kid]
	v.mu.Unlock()
	if k != nil {
		return k, nil
	}
	raw, err := v.fetch(ctx, kid)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, fmt.Errorf("ALB key %s: not PEM", kid)
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("ALB key %s: %w", kid, err)
	}
	ec, ok := pub.(*ecdsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("ALB key %s: not an EC key", kid)
	}
	v.mu.Lock()
	v.keys[kid] = ec
	v.mu.Unlock()
	return ec, nil
}

// verify checks signature and expiry; errAlbInvalid means a bad token.
func (v *albVerifier) verify(ctx context.Context, token string) (sub, email string, err error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", "", errAlbInvalid
	}
	var header struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
		Exp int64  `json:"exp"`
	}
	var claims struct {
		Sub   string `json:"sub"`
		Email string `json:"email"`
		Exp   int64  `json:"exp"`
	}
	hraw, err1 := b64(parts[0])
	craw, err2 := b64(parts[1])
	sig, err3 := b64(parts[2])
	if err1 != nil || err2 != nil || err3 != nil ||
		json.Unmarshal(hraw, &header) != nil || json.Unmarshal(craw, &claims) != nil {
		return "", "", errAlbInvalid
	}
	if header.Alg != "ES256" || header.Kid == "" || len(sig) != 64 {
		return "", "", errAlbInvalid
	}
	// A key fetch failure is an outage, not a forgery.
	key, err := v.key(ctx, header.Kid)
	if err != nil {
		return "", "", err
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	r, s := new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])
	if !ecdsa.Verify(key, digest[:], r, s) {
		return "", "", errAlbInvalid
	}
	exp := claims.Exp
	if exp == 0 {
		exp = header.Exp // ALB also puts exp in the header
	}
	if exp == 0 || v.now().After(time.Unix(exp, 0).Add(albClockSkew)) {
		return "", "", errAlbInvalid
	}
	if claims.Sub == "" {
		return "", "", errAlbInvalid
	}
	return claims.Sub, claims.Email, nil
}
