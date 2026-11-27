// Package oma implements the rclone remote used for sandbox-scoped File API
// mounts. The token is deliberately read from OPENMA_SANDBOX_TOKEN, never a
// rclone config field or command-line argument. The gateway remains the
// authorization boundary and must validate the token's session, attempt, and
// path scope on every request.
package oma

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/fs/config/configstruct"
	"github.com/rclone/rclone/fs/fshttp"
	"github.com/rclone/rclone/fs/hash"
)

const (
	backendName = "oma"
	tokenEnv    = "OPENMA_SANDBOX_TOKEN"
	endpointEnv = "OMA_GATEWAY_ENDPOINT"
	sessionEnv  = "OMA_SESSION_ID"
	objectsPath = "/v1/oma/storage/sessions"
)

func init() {
	fs.Register(&fs.RegInfo{
		Name:        backendName,
		Description: "Open Managed Agents sandbox File API",
		NewFs:       NewFs,
		Options: []fs.Option{{
			Name:     "endpoint",
			Help:     "File API gateway endpoint; defaults to OMA_GATEWAY_ENDPOINT.",
			Advanced: true,
		}, {
			Name:     "session_id",
			Help:     "Sandbox Session id; defaults to OMA_SESSION_ID.",
			Advanced: true,
		}, {
			Name:     "timeout",
			Help:     "HTTP request timeout in seconds.",
			Default:  60,
			Advanced: true,
		}},
	})
}

type options struct {
	Endpoint string `config:"endpoint"`
	Session  string `config:"session_id"`
	Timeout  int    `config:"timeout"`
}

// Fs is a session-scoped remote rooted at the path after :oma:. For example,
// :oma:memory/store-id and :oma:outputs/workspace/session are separate roots.
type Fs struct {
	name     string
	root     string
	session  string
	endpoint string
	token    string
	client   *http.Client
	features *fs.Features
}

// Object is a File API object whose bytes are streamed by the gateway.
type Object struct {
	fs      *Fs
	remote  string
	size    int64
	modTime time.Time
	hash    string
}

type directory struct {
	f       *Fs
	remote  string
	modTime time.Time
	items   int64
}

type listEntry struct {
	Path    string    `json:"path"`
	IsDir   bool      `json:"is_dir"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"mod_time"`
	Hash    string    `json:"sha256"`
}

type listResponse struct {
	Entries []listEntry `json:"entries"`
}

type statResponse struct {
	Size    int64     `json:"size"`
	ModTime time.Time `json:"mod_time"`
	Hash    string    `json:"sha256"`
}

func NewFs(ctx context.Context, name, root string, m configmap.Mapper) (fs.Fs, error) {
	var opt options
	if err := configstruct.Set(m, &opt); err != nil {
		return nil, err
	}
	endpoint := strings.TrimRight(opt.Endpoint, "/")
	if endpoint == "" {
		endpoint = strings.TrimRight(os.Getenv(endpointEnv), "/")
	}
	if endpoint == "" {
		return nil, errors.New("oma: OMA_GATEWAY_ENDPOINT is required")
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("oma: invalid gateway endpoint %q", endpoint)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("oma: gateway endpoint must use HTTP(S), got %q", u.Scheme)
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("oma: gateway endpoint must not include a query or fragment")
	}
	token := os.Getenv(tokenEnv)
	if token == "" {
		return nil, errors.New("oma: OPENMA_SANDBOX_TOKEN is required")
	}
	session := opt.Session
	if session == "" {
		session = os.Getenv(sessionEnv)
	}
	if session == "" || strings.ContainsAny(session, "/\\\x00") || session == "." || session == ".." {
		return nil, errors.New("oma: OMA_SESSION_ID is required and must be one safe path segment")
	}
	if opt.Timeout <= 0 {
		opt.Timeout = 60
	}
	root = cleanRoot(root)
	if root == ".." || strings.HasPrefix(root, "../") || strings.ContainsAny(root, "\\\x00") {
		return nil, fmt.Errorf("oma: unsafe remote root %q", root)
	}
	client := fshttp.NewClientCustom(ctx, func(transport *http.Transport) {
		transport.ResponseHeaderTimeout = time.Duration(opt.Timeout) * time.Second
	})
	client.Timeout = time.Duration(opt.Timeout) * time.Second
	return &Fs{
		name:     name,
		root:     root,
		session:  session,
		endpoint: endpoint,
		token:    token,
		client:   client,
		features: (&fs.Features{CanHaveEmptyDirectories: true, NoMultiThreading: true}).Fill(ctx, nil),
	}, nil
}

func (f *Fs) Name() string { return f.name }
func (f *Fs) Root() string { return f.root }
func (f *Fs) String() string {
	return f.endpoint + objectsPath + "/" + url.PathEscape(f.session) + "/objects/" + f.root
}
func (f *Fs) Precision() time.Duration { return time.Second }
func (f *Fs) Hashes() hash.Set         { return hash.Set(hash.None) }
func (f *Fs) Features() *fs.Features   { return f.features }

func (f *Fs) List(ctx context.Context, dir string) (fs.DirEntries, error) {
	dir, err := f.remotePath(dir)
	if err != nil {
		return nil, err
	}
	query := url.Values{}
	query.Set("prefix", dir)
	var response listResponse
	if err := f.doJSON(ctx, http.MethodGet, "", query, nil, &response); err != nil {
		if errors.Is(err, fs.ErrorObjectNotFound) {
			return nil, fs.ErrorDirNotFound
		}
		return nil, err
	}
	entries := make(fs.DirEntries, 0, len(response.Entries))
	for _, item := range response.Entries {
		remote, err := f.remotePath(path.Join(dir, item.Path))
		if err != nil {
			return nil, fmt.Errorf("oma: gateway returned unsafe path %q: %w", item.Path, err)
		}
		if item.IsDir {
			entries = append(entries, &directory{f: f, remote: remote, modTime: item.ModTime})
		} else {
			entries = append(entries, &Object{fs: f, remote: remote, size: item.Size, modTime: item.ModTime, hash: item.Hash})
		}
	}
	return entries, nil
}

func (f *Fs) NewObject(ctx context.Context, remote string) (fs.Object, error) {
	remote, err := f.remotePath(remote)
	if err != nil {
		return nil, err
	}
	response, err := f.do(ctx, http.MethodHead, remote, nil, nil)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	modTime, _ := time.Parse(time.RFC3339Nano, response.Header.Get("X-OMA-Mod-Time"))
	size := response.ContentLength
	if value := response.Header.Get("X-OMA-Size"); value != "" {
		_, _ = fmt.Sscan(value, &size)
	}
	return &Object{fs: f, remote: remote, size: size, modTime: modTime, hash: response.Header.Get("X-OMA-SHA256")}, nil
}

func (f *Fs) Put(ctx context.Context, in io.Reader, src fs.ObjectInfo, options ...fs.OpenOption) (fs.Object, error) {
	remote := src.Remote()
	if _, err := f.put(ctx, remote, in, src, options...); err != nil {
		return nil, err
	}
	return &Object{fs: f, remote: remote, size: src.Size(), modTime: src.ModTime(ctx)}, nil
}

func (f *Fs) Mkdir(ctx context.Context, dir string) error {
	dir, err := f.remotePath(dir)
	if err != nil {
		return err
	}
	_, err = f.do(ctx, http.MethodPost, "/directories/"+f.pathSuffix(dir), nil, nil)
	return err
}

func (f *Fs) Rmdir(ctx context.Context, dir string) error {
	dir, err := f.remotePath(dir)
	if err != nil {
		return err
	}
	_, err = f.do(ctx, http.MethodDelete, "/directories/"+f.pathSuffix(dir), nil, nil)
	return err
}

func (f *Fs) put(ctx context.Context, remote string, in io.Reader, src fs.ObjectInfo, _ ...fs.OpenOption) (*http.Response, error) {
	if src.Size() < 0 {
		return nil, errors.New("oma: unknown-size uploads are not supported")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, f.objectURL(remote), in)
	if err != nil {
		return nil, err
	}
	f.authorize(request)
	request.ContentLength = src.Size()
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Header.Set("X-OMA-Mod-Time", src.ModTime(ctx).UTC().Format(time.RFC3339Nano))
	response, err := f.client.Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		return nil, f.statusError(response)
	}
	return response, nil
}

func (o *Object) Fs() fs.Info                                     { return o.fs }
func (o *Object) String() string                                  { return o.remote }
func (o *Object) Remote() string                                  { return o.remote }
func (o *Object) ModTime(context.Context) time.Time               { return o.modTime }
func (o *Object) Size() int64                                     { return o.size }
func (o *Object) Storable() bool                                  { return true }
func (o *Object) Hash(context.Context, hash.Type) (string, error) { return o.hash, nil }

func (o *Object) SetModTime(ctx context.Context, modTime time.Time) error {
	payload := struct {
		ModTime time.Time `json:"mod_time"`
	}{ModTime: modTime}
	err := o.fs.doJSON(ctx, http.MethodPatch, o.remote, nil, payload, nil)
	if err == nil {
		o.modTime = modTime
	}
	return err
}

func (o *Object) Open(ctx context.Context, options ...fs.OpenOption) (io.ReadCloser, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, o.fs.objectURL(o.remote), nil)
	if err != nil {
		return nil, err
	}
	o.fs.authorize(request)
	for _, option := range options {
		if key, value := option.Header(); key != "" {
			request.Header.Set(key, value)
		}
	}
	response, err := o.fs.client.Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		return nil, o.fs.statusError(response)
	}
	return response.Body, nil
}

func (o *Object) Update(ctx context.Context, in io.Reader, src fs.ObjectInfo, options ...fs.OpenOption) error {
	response, err := o.fs.put(ctx, o.remote, in, src, options...)
	if response != nil {
		_ = response.Body.Close()
	}
	if err == nil {
		o.size = src.Size()
		o.modTime = src.ModTime(ctx)
	}
	return err
}

func (o *Object) Remove(ctx context.Context) error {
	_, err := o.fs.do(ctx, http.MethodDelete, o.remote, nil, nil)
	return err
}

func (d *directory) Fs() fs.Info                       { return d.f }
func (d *directory) String() string                    { return d.remote }
func (d *directory) Remote() string                    { return d.remote }
func (d *directory) ModTime(context.Context) time.Time { return d.modTime }
func (d *directory) Size() int64                       { return -1 }
func (d *directory) Items() int64                      { return d.items }
func (d *directory) ID() string                        { return "" }

func (f *Fs) doJSON(ctx context.Context, method, remote string, query url.Values, body any, result any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = strings.NewReader(string(encoded))
	}
	response, err := f.do(ctx, method, remote, query, reader)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if result == nil || response.StatusCode == http.StatusNoContent {
		return nil
	}
	if err := json.NewDecoder(response.Body).Decode(result); err != nil && !errors.Is(err, io.EOF) {
		return fmt.Errorf("oma: invalid gateway response: %w", err)
	}
	return nil
}

func (f *Fs) do(ctx context.Context, method, remote string, query url.Values, body io.Reader) (*http.Response, error) {
	target := f.objectURL(remote)
	if strings.HasPrefix(remote, "/directories/") {
		target = f.endpoint + objectsPath + "/" + url.PathEscape(f.session) + "/objects" + remote
	}
	request, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, err
	}
	if query != nil {
		request.URL.RawQuery = query.Encode()
	}
	f.authorize(request)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := f.client.Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		return nil, f.statusError(response)
	}
	return response, nil
}

func (f *Fs) statusError(response *http.Response) error {
	if response.StatusCode == http.StatusNotFound {
		return fs.ErrorObjectNotFound
	}
	if response.StatusCode == http.StatusForbidden || response.StatusCode == http.StatusUnauthorized {
		return fmt.Errorf("oma: gateway rejected sandbox token (%s)", response.Status)
	}
	return fmt.Errorf("oma: gateway returned %s", response.Status)
}

func (f *Fs) authorize(request *http.Request) {
	request.Header.Set("Authorization", "Bearer "+f.token)
	request.Header.Set("X-OMA-Storage-Protocol", "1")
}

func (f *Fs) objectURL(remote string) string {
	return f.endpoint + objectsPath + "/" + url.PathEscape(f.session) + "/objects/" + f.pathSuffix(remote)
}

func (f *Fs) pathSuffix(remote string) string {
	remote = cleanRoot(remote)
	joined := cleanRoot(path.Join(f.root, remote))
	segments := strings.Split(joined, "/")
	for i := range segments {
		segments[i] = url.PathEscape(segments[i])
	}
	return strings.Join(segments, "/")
}

func (f *Fs) remotePath(remote string) (string, error) {
	remote = cleanRoot(remote)
	if remote == "." {
		remote = ""
	}
	if strings.HasPrefix(remote, "../") || remote == ".." || strings.ContainsAny(remote, "\\\x00") {
		return "", fmt.Errorf("oma: unsafe remote path %q", remote)
	}
	return remote, nil
}

func cleanRoot(value string) string {
	value = strings.Trim(value, "/")
	if value == "" || value == "." {
		return ""
	}
	return path.Clean(value)
}

var (
	_ fs.Fs     = (*Fs)(nil)
	_ fs.Object = (*Object)(nil)
)
