package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
)

// Covers: the album's coverLid wins when the albums index knows the album and
// has art for it; otherwise the row keeps the track's own lid.

func coverHits() []map[string]interface{} {
	return []map[string]interface{}{
		// album in the index WITH a coverLid: both rows take the album cover
		{"lid": "e182ccc85ad", "title": "One More Time", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "track": 1.0},
		{"lid": "a1b2c3d4e5f", "title": "Aerodynamic", "artist": "Daft Punk", "albumArtist": "Daft Punk", "album": "Discovery", "track": 2.0},
		// album in the index WITHOUT a coverLid: the track's own lid
		{"lid": "0123456789a", "title": "Lady", "artist": "Modjo", "albumArtist": "Modjo", "album": "Modjo", "track": 3.0},
		// single keyed by artist (no albumArtist), unknown to the albums index
		{"lid": "bbbbbbbbbbb", "title": "Second", "artist": "Sam Gellaitry", "album": "Assumptions", "track": 2.0},
		// no album at all
		{"lid": "ccccccccccc", "title": "Loose", "artist": "Nobody"},
		// no lid: never rendered
		{"title": "Ghost", "artist": "Daft Punk", "album": "Discovery"},
	}
}

func newCoverStub(t *testing.T) *shelfStub {
	t.Helper()
	stub := newShelfStub(t)
	stub.hits["tracks"] = coverHits()
	stub.hits["albums"] = []map[string]interface{}{
		{"id": albumID("Daft Punk", "Discovery"), "album": "Discovery", "albumArtist": "Daft Punk", "coverLid": "e182ccc85ad", "artistId": artistID("Daft Punk")},
		{"id": albumID("Modjo", "Modjo"), "album": "Modjo", "albumArtist": "Modjo", "coverLid": "", "artistId": artistID("Modjo")},
		// same artist, another album: returned by the albumArtist filter, must be ignored
		{"id": albumID("Daft Punk", "Homework"), "album": "Homework", "albumArtist": "Daft Punk", "coverLid": "ffffffffff0", "artistId": artistID("Daft Punk")},
	}
	return stub
}

func thumbLid(t *testing.T, th []Thumbnail) string {
	t.Helper()
	if len(th) == 0 {
		t.Fatalf("no thumbnail")
	}
	_, lid, _ := strings.Cut(th[0].URL, "lid=")
	return lid
}

func TestAlbumCoversBatchesOneQuery(t *testing.T) {
	stub := newCoverStub(t)
	covers := albumCovers(coverHits())
	if strings.Join(stub.queried, ",") != "albums" {
		t.Fatalf("expected exactly one albums query, got %v", stub.queried)
	}
	// filter on the distinct albumArtist values (the index is not filterable on id), sorted
	if f := stub.filters[0]; f != `albumArtist IN ["Daft Punk","Modjo","Sam Gellaitry"]` {
		t.Fatalf("unexpected filter %q", f)
	}
	if covers[albumID("Daft Punk", "Discovery")] != "e182ccc85ad" {
		t.Fatalf("Discovery must resolve to its coverLid, got %+v", covers)
	}
	if c, ok := covers[albumID("Modjo", "Modjo")]; !ok || c != "" {
		t.Fatalf("Modjo is known without cover: expected an empty entry, got %+v", covers)
	}
	if c, ok := covers[albumID("Sam Gellaitry", "Assumptions")]; !ok || c != "" {
		t.Fatalf("unknown album must be memoised empty, got %+v", covers)
	}
	if _, ok := covers[albumID("Daft Punk", "Homework")]; ok {
		t.Fatalf("albums nobody asked for must not leak into the result: %+v", covers)
	}
	// memo: a second batch over the same hits touches Meili no more
	albumCovers(coverHits())
	if len(stub.queried) != 1 {
		t.Fatalf("second batch must be served from the memo, queried %v", stub.queried)
	}
}

// variousArtists returns n filler album docs sharing one albumArtist.
func variousArtists(n int) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, n+1)
	for i := 0; i < n; i++ {
		out = append(out, map[string]interface{}{
			"id": albumID("Various Artists", fmt.Sprintf("Comp %05d", i)), "albumArtist": "Various Artists", "coverLid": "ffffffffff0",
		})
	}
	return out
}

// G9: an albumArtist with more than albumCoverBatchLimit albums: the wanted
// album sits on the second page and must be resolved by a second query, not
// memoised as absent.
func TestAlbumCoversPagesPastBatchLimit(t *testing.T) {
	stub := newShelfStub(t)
	wanted := albumID("Various Artists", "Zebra Mix")
	stub.hits["albums"] = append(variousArtists(albumCoverBatchLimit), map[string]interface{}{
		"id": wanted, "albumArtist": "Various Artists", "coverLid": "e182ccc85ad",
	})
	hits := []map[string]interface{}{
		{"lid": "0123456789a", "title": "Zebra", "artist": "Someone", "albumArtist": "Various Artists", "album": "Zebra Mix"},
	}
	covers := albumCovers(hits)
	if covers[wanted] != "e182ccc85ad" {
		t.Fatalf("album on the second page must resolve, got %+v", covers)
	}
	if strings.Join(stub.queried, ",") != "albums,albums" {
		t.Fatalf("expected two paged albums queries, got %v", stub.queried)
	}
	if c, ok := albumCoverCached(wanted); !ok || c != "e182ccc85ad" {
		t.Fatalf("resolved cover must be memoised, got %q/%v", c, ok)
	}
	// the row carries the album cover
	if got := thumbLid(t, localSongItemsWithCovers(hits)[0].Thumbnails); got != "e182ccc85ad" {
		t.Fatalf("row must carry the paged album cover, got %s", got)
	}
}

// G9: when the page cap is reached without finding the album, nothing
// negative is memoised, so the per-item document GET can still resolve it.
func TestAlbumCoversNoNegativeMemoWhenCapped(t *testing.T) {
	stub := newShelfStub(t)
	stub.pageless = true // every page is full and never carries the wanted id
	stub.hits["albums"] = variousArtists(albumCoverBatchLimit)
	wanted := albumID("Various Artists", "Zebra Mix")
	hits := []map[string]interface{}{
		{"lid": "0123456789a", "title": "Zebra", "artist": "Someone", "albumArtist": "Various Artists", "album": "Zebra Mix"},
	}
	covers := albumCovers(hits)
	if c, ok := covers[wanted]; !ok || c != "" {
		t.Fatalf("unresolved album must be an empty entry of this batch, got %+v", covers)
	}
	if len(stub.queried) != albumCoverMaxPages {
		t.Fatalf("expected %d paged queries, got %v", albumCoverMaxPages, len(stub.queried))
	}
	if _, ok := albumCoverCached(wanted); ok {
		t.Fatalf("album beyond the page cap must NOT be memoised as absent")
	}
	// the per-item fallback (document GET) still finds it
	stub.hits["albums"] = append(stub.hits["albums"], map[string]interface{}{"id": wanted, "albumArtist": "Various Artists", "coverLid": "e182ccc85ad"})
	if got := albumCoverFor(wanted); got != "e182ccc85ad" {
		t.Fatalf("document GET fallback must resolve the album, got %q", got)
	}
}

func TestLocalSongItemsWithCoversRule(t *testing.T) {
	stub := newCoverStub(t)
	items := localSongItemsWithCovers(coverHits())
	if len(items) != 5 {
		t.Fatalf("expected the 5 lid-bearing hits, got %d", len(items))
	}
	want := map[string]string{
		"e182ccc85ad": "e182ccc85ad", // album cover (its own lid here)
		"a1b2c3d4e5f": "e182ccc85ad", // album cover, not the track's lid
		"0123456789a": "0123456789a", // album known, no cover: own lid
		"bbbbbbbbbbb": "bbbbbbbbbbb", // album unknown: own lid
		"ccccccccccc": "ccccccccccc", // no album: own lid
	}
	for _, it := range items {
		if got := thumbLid(t, it.Thumbnails); got != want[*it.VideoId] {
			t.Fatalf("lid %s: expected cover %s, got %s", *it.VideoId, want[*it.VideoId], got)
		}
	}
	// one batched albums query, no per-item document GET
	if strings.Join(stub.queried, ",") != "albums" {
		t.Fatalf("expected one albums query, got %v", stub.queried)
	}
}

func TestLocalSongItemAloneFallsBackToDocumentGet(t *testing.T) {
	stub := newCoverStub(t)
	h := coverHits()[1] // Aerodynamic, Discovery
	it := localSongItem(h)
	if got := thumbLid(t, it.Thumbnails); got != "e182ccc85ad" {
		t.Fatalf("unbatched item must still resolve the album cover, got %s", got)
	}
	if strings.Join(stub.queried, ",") != "albums/doc" {
		t.Fatalf("expected one document GET, got %v", stub.queried)
	}
	// same album again: memo, no query; lidItem (queue items) follows the same rule
	q := lidItem(coverHits()[0])
	if got := thumbLid(t, q.Thumbnails); got != "e182ccc85ad" || len(stub.queried) != 1 {
		t.Fatalf("lidItem: expected memoised album cover, got %s / queried %v", got, stub.queried)
	}
	// unknown album: the GET 404s, memoised empty -> own lid, and only once
	for i := 0; i < 2; i++ {
		if got := thumbLid(t, localSongItem(coverHits()[3]).Thumbnails); got != "bbbbbbbbbbb" {
			t.Fatalf("unknown album must keep the track lid, got %s", got)
		}
	}
	if strings.Join(stub.queried, ",") != "albums/doc,albums/doc" {
		t.Fatalf("expected one GET per distinct album, got %v", stub.queried)
	}
	// no Meili at all: the item still builds with its own lid
	t.Setenv("MEILI_URL", "")
	resetAlbumCoverMemo()
	if got := thumbLid(t, localSongItem(h).Thumbnails); got != "a1b2c3d4e5f" {
		t.Fatalf("without Meili the track lid must be used, got %s", got)
	}
}

func TestLocalShelfSongsUseAlbumCover(t *testing.T) {
	stub := newCoverStub(t)
	s := localShelf("daft", "songs")
	if s == nil || len(s.Contents) != 5 {
		t.Fatalf("expected the shelf with 5 rows, got %+v", s)
	}
	if got := thumbLid(t, s.Contents[1].Thumbnails); got != "e182ccc85ad" {
		t.Fatalf("shelf row must carry the album cover, got %s", got)
	}
	if strings.Join(stub.queried, ",") != "tracks,albums" {
		t.Fatalf("expected tracks then one albums query, got %v", stub.queried)
	}
}

func TestLocalSongsHandlerUsesAlbumCover(t *testing.T) {
	stub := newCoverStub(t)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/local/songs?limit=10", nil)
	rec := httptest.NewRecorder()
	if err := LocalSongsHandler(e.NewContext(req, rec)); err != nil {
		t.Fatal(err)
	}
	var body struct {
		Items []struct {
			VideoId    string      `json:"videoId"`
			Thumbnails []Thumbnail `json:"thumbnails"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Items) != 5 || body.Items[1].VideoId != "a1b2c3d4e5f" {
		t.Fatalf("expected 5 rows, got %+v", body.Items)
	}
	if got := thumbLid(t, body.Items[1].Thumbnails); got != "e182ccc85ad" {
		t.Fatalf("local/songs row must carry the album cover, got %s", got)
	}
	if strings.Join(stub.queried, ",") != "tracks,albums" {
		t.Fatalf("expected tracks then one albums query, got %v", stub.queried)
	}
}

func TestLocalRelatedUsesAlbumCover(t *testing.T) {
	stub := newCoverStub(t)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/local/related?lid=e182ccc85ad", nil)
	rec := httptest.NewRecorder()
	if err := LocalRelatedHandler(e.NewContext(req, rec)); err != nil {
		t.Fatal(err)
	}
	var body struct {
		Items []struct {
			VideoId    string      `json:"videoId"`
			Thumbnails []Thumbnail `json:"thumbnails"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, it := range body.Items {
		if it.VideoId == "a1b2c3d4e5f" {
			found = true
			if got := thumbLid(t, it.Thumbnails); got != "e182ccc85ad" {
				t.Fatalf("related row must carry the album cover, got %s", got)
			}
		}
	}
	if !found {
		t.Fatalf("Aerodynamic expected in the related list, got %+v", body.Items)
	}
	// radioPool primes the memo once; no per-item document GET afterwards
	n := 0
	for _, q := range stub.queried {
		if q == "albums" {
			n++
		}
		if q == "albums/doc" {
			t.Fatalf("related must not fall back to per-item GETs, queried %v", stub.queried)
		}
	}
	if n != 1 {
		t.Fatalf("expected exactly one albums query, queried %v", stub.queried)
	}
}
