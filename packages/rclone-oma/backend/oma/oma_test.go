package oma

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rclone/rclone/fs/config/configmap"
)

func TestRemoteUsesSessionTokenAndStreamsObjects(t *testing.T) {
	t.Setenv(tokenEnv, "oma_sbx_test")
	t.Setenv(sessionEnv, "sess")
	var putBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer oma_sbx_test" {
			t.Fatalf("authorization header = %q", request.Header.Get("Authorization"))
		}
		if request.URL.Path != "/v1/oma/storage/sessions/sess/objects/memory/store" && request.URL.Path != "/v1/oma/storage/sessions/sess/objects/memory/store/a.txt" {
			t.Fatalf("unexpected path %q", request.URL.Path)
		}
		switch request.Method {
		case http.MethodGet:
			if request.URL.Query().Has("prefix") {
				w.Header().Set("content-type", "application/json")
				_, _ = io.WriteString(w, `{"entries":[{"path":"a.txt","is_dir":false,"size":5,"mod_time":"2026-01-01T00:00:00Z"}]}`)
				return
			}
			_, _ = io.WriteString(w, "hello")
		case http.MethodHead:
			w.Header().Set("x-oma-size", "5")
			w.Header().Set("x-oma-mod-time", "2026-01-01T00:00:00Z")
		case http.MethodPut:
			body, _ := io.ReadAll(request.Body)
			putBody = string(body)
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected method %s", request.Method)
		}
	}))
	defer server.Close()

	remote, err := NewFs(context.Background(), "test", "memory/store", configmap.Simple{"endpoint": server.URL})
	if err != nil {
		t.Fatal(err)
	}
	entries, err := remote.List(context.Background(), "")
	if err != nil || len(entries) != 1 {
		t.Fatalf("list = %#v, %v", entries, err)
	}
	object, err := remote.NewObject(context.Background(), "a.txt")
	if err != nil {
		t.Fatal(err)
	}
	reader, err := object.Open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	content, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil || string(content) != "hello" {
		t.Fatalf("content = %q, %v", content, err)
	}
	if err := object.Update(context.Background(), strings.NewReader("world"), object); err != nil {
		t.Fatal(err)
	}
	if putBody != "world" {
		t.Fatalf("put body = %q", putBody)
	}
}

func TestNewFsRequiresSessionToken(t *testing.T) {
	t.Setenv(tokenEnv, "")
	t.Setenv(endpointEnv, "https://control.example")
	t.Setenv(sessionEnv, "sess")
	if _, err := NewFs(context.Background(), "test", "memory/store", configmap.Simple{}); err == nil || !strings.Contains(err.Error(), tokenEnv) {
		t.Fatalf("error = %v", err)
	}
}

func TestNewFsRequiresHTTPGateway(t *testing.T) {
	t.Setenv(tokenEnv, "oma_sbx_test")
	t.Setenv(sessionEnv, "sess")
	if _, err := NewFs(context.Background(), "test", "memory/store", configmap.Simple{"endpoint": "ftp://control.example"}); err == nil || !strings.Contains(err.Error(), "HTTP(S)") {
		t.Fatalf("error = %v", err)
	}
	if _, err := NewFs(context.Background(), "test", "memory/store", configmap.Simple{"endpoint": "https://control.example?token=leak"}); err == nil || !strings.Contains(err.Error(), "query or fragment") {
		t.Fatalf("error = %v", err)
	}
}

func TestDirectoryOperationsRejectTraversal(t *testing.T) {
	t.Setenv(tokenEnv, "oma_sbx_test")
	t.Setenv(sessionEnv, "sess")
	remote, err := NewFs(context.Background(), "test", "memory/store", configmap.Simple{"endpoint": "https://control.example"})
	if err != nil {
		t.Fatal(err)
	}
	if err := remote.Mkdir(context.Background(), "../outside"); err == nil {
		t.Fatal("Mkdir accepted a path outside the remote root")
	}
	if err := remote.Rmdir(context.Background(), "../../outside"); err == nil {
		t.Fatal("Rmdir accepted a path outside the remote root")
	}
}
