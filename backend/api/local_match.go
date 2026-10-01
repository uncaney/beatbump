package api

// D5 "Tu l'as deja": strict match of a YouTube album (artist + title) against
// the local albums index. Meili gives the candidates (typo tolerant, so far too
// loose on its own); a candidate only counts when its normalised title AND
// album artist are equal to the query's, so "Discovery (Deluxe)" matches the
// local "Discovery" but "Alive 2007" never matches "Alive 1997".

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/labstack/echo/v4"
)

// matchAccents folds the Latin accented letters found in tags to ASCII.
var matchAccents = strings.NewReplacer(
	"à", "a", "á", "a", "â", "a", "ã", "a", "ä", "a", "å", "a", "æ", "ae",
	"ç", "c", "è", "e", "é", "e", "ê", "e", "ë", "e",
	"ì", "i", "í", "i", "î", "i", "ï", "i", "ñ", "n",
	"ò", "o", "ó", "o", "ô", "o", "õ", "o", "ö", "o", "ø", "o", "œ", "oe",
	"ù", "u", "ú", "u", "û", "u", "ü", "u", "ý", "y", "ÿ", "y", "ß", "ss",
	"’", "'", "‘", "'", "“", "\"", "”", "\"", "–", "-", "—", "-",
)

// matchEditionWords mark a bracketed / dashed qualifier as a pure packaging
// label (dropped): Deluxe, Remastered, Expanded, Anniversary, Bonus Track
// Version, Explicit, Clean, "Edition" alone... Version words that change the
// content (live, remix, acoustic, instrumental, "(Taylor's Version)") are
// deliberately absent, and "edit" is too ("Radio Edit", "Extended Edit" are
// other cuts).
const matchEditionWords = `deluxe|remaster(?:ed)?|edition|expanded|anniversary|bonus|special|collector'?s?|super|explicit|clean|reissue`

// matchContentWords (L12-4, audit logic v12) keep a qualifier that names
// different content even when it also carries a packaging word: "(Drumless
// Edition)", "(Live Edition)", "(Instrumental Edition)", "(Acoustic Edition)",
// "(Remix Edition)", "(Demo Edition)" are not the same album as the plain one.
const matchContentWords = `live|drumless|instrumentals?|acoustic|remix\w*|demos?|karaoke|a ?cappella|acapella|unplugged|orchestral|commentary`

var (
	matchBracketRe = regexp.MustCompile(`[\(\[\{][^\)\]\}]*\b(?:` + matchEditionWords + `)\b[^\)\]\}]*[\)\]\}]`)
	matchDashRe    = regexp.MustCompile(`\s+-\s+[^-]*\b(?:` + matchEditionWords + `)\b.*$`)
	matchContentRe = regexp.MustCompile(`\b(?:` + matchContentWords + `)\b`)
	matchFeatRe    = regexp.MustCompile(`[\(\[]?\b(?:feat|ft|featuring)\b\.?.*$`)
	matchNonAlnum  = regexp.MustCompile(`[^a-z0-9]+`)
	matchArtistSep = regexp.MustCompile(`\s*(?:,|&|/|;|\bx\b|\band\b|\bet\b|\bwith\b)\s*`)
)

// matchDropPackaging removes the packaging qualifiers of a lowercased,
// accent-folded title; a qualifier naming other content stays.
func matchDropPackaging(s string) string {
	keep := func(q string) string {
		if matchContentRe.MatchString(q) {
			return q
		}
		return " "
	}
	s = matchBracketRe.ReplaceAllStringFunc(s, keep)
	return matchDashRe.ReplaceAllStringFunc(s, keep)
}

// matchHasPackaging reports whether a raw title carries a packaging
// qualifier that matchNorm drops ("Discovery (Deluxe)": true, "Discovery":
// false, "Alive (Live Edition)": false).
func matchHasPackaging(s string) bool {
	s = matchAccents.Replace(strings.ToLower(s))
	return matchDropPackaging(s) != s
}

// matchNorm normalises an album title or artist name for the strict
// comparison: case, accents, edition qualifiers ("(Deluxe)", "[Remastered]",
// " - 2011 Remaster"), "feat. ..." tails, punctuation and spacing.
func matchNorm(s string) string {
	s = matchAccents.Replace(strings.ToLower(s))
	s = matchDropPackaging(s)
	s = matchFeatRe.ReplaceAllString(s, " ")
	s = strings.ReplaceAll(s, "&", " and ")
	s = strings.ReplaceAll(s, "'", "")
	s = matchNonAlnum.ReplaceAllString(s, " ")
	return strings.Join(strings.Fields(s), " ")
}

// matchPrimaryArtist is the first credited artist of a normalised-ready name
// ("Daft Punk & Pharrell" -> "daft punk").
func matchPrimaryArtist(s string) string {
	s = matchAccents.Replace(strings.ToLower(s))
	s = matchFeatRe.ReplaceAllString(s, " ")
	if parts := matchArtistSep.Split(s, 2); len(parts) > 0 {
		s = parts[0]
	}
	return matchNorm(s)
}

// albumStrictMatch reports whether a local album doc is the same album as the
// YouTube (artist, title) pair.
func albumStrictMatch(artist, title string, doc map[string]interface{}) bool {
	nt := matchNorm(title)
	if nt == "" || matchNorm(mstr(doc, "album")) != nt {
		return false
	}
	qa, la := matchNorm(artist), matchNorm(mstr(doc, "albumArtist"))
	if qa == "" || la == "" {
		return false
	}
	if qa == la {
		return true
	}
	pq, pl := matchPrimaryArtist(artist), matchPrimaryArtist(mstr(doc, "albumArtist"))
	return pq != "" && pq == pl
}

// localAlbumSearchFn is the Meili albums search (a variable for tests).
var localAlbumSearchFn = func(q string) []map[string]interface{} {
	return meiliSearchIndex("albums", map[string]interface{}{
		"q": q, "limit": 10, "attributesToRetrieve": albumDocAttrs,
	})
}

// findLocalAlbumMatch returns the first local album doc strictly equal to
// (artist, title), searching "title artist" then the title alone.
func findLocalAlbumMatch(artist, title string) map[string]interface{} {
	if matchNorm(title) == "" || matchNorm(artist) == "" {
		return nil
	}
	seen := map[string]bool{}
	for _, q := range []string{strings.TrimSpace(title + " " + artist), title} {
		for _, d := range localAlbumSearchFn(q) {
			id := mstr(d, "id")
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			if albumStrictMatch(artist, title, d) {
				return d
			}
		}
	}
	return nil
}

// LocalAlbumMatchHandler serves GET /api/v1/local/albums/match?artist=&title=:
// {"match": {id, title, artist, thumbnail, trackCount, href}} or {"match": null}.
func LocalAlbumMatchHandler(c echo.Context) error {
	artist, title := c.QueryParam("artist"), c.QueryParam("title")
	if strings.TrimSpace(artist) == "" || strings.TrimSpace(title) == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "bad_request", "reason": "artist and title are required"})
	}
	d := findLocalAlbumMatch(artist, title)
	if d == nil {
		return c.JSON(http.StatusOK, map[string]interface{}{"match": nil})
	}
	id := mstr(d, "id")
	thumb := ""
	if lid := mstr(d, "coverLid"); lid != "" {
		thumb = coverURL(lid)
	}
	return c.JSON(http.StatusOK, map[string]interface{}{"match": map[string]interface{}{
		"id":         id,
		"title":      mstr(d, "album"),
		"artist":     mstr(d, "albumArtist"),
		"thumbnail":  thumb,
		"trackCount": mint(d, "trackCount"),
		"href":       "/release?id=" + id,
	}})
}
