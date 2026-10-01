package api

// U12-5 (audit UX v12): the `genre` tag is free text. Raw facet values such
// as "Acoustic Rock;Blues Rock;Classic Rock", "bossa nova/samba/soundtrack",
// "_Soundtrack" or "B.O." were listed as genres on /library/genres.
// normalizeGenres splits each raw value on ";" and "/", trims, drops junk
// (empty, shorter than 2 characters, starting with "_", dotted abbreviations
// such as "B.O."), merges case variants (the most frequent spelling names the
// entry) and sums the track counts of every raw value holding the genre.
// genreSongsFilter maps such a name back to the raw values that contain it, so
// local/songs?genre=Blues%20Rock still finds the tracks tagged with the
// combined string.
//
// Audit L11-6 (cycle 40): values are also split on "," and "|"; "/" splits
// only when every side has at least 4 characters and the value is not a known
// slash name ("Singer/Songwriter", "AC/DC", "R&B/Soul" stay whole); the
// soundtrack spellings (B.O., BSO, OST, score, soundtrack, "Bande originale",
// "_Soundtrack"...) are one genre, "Bande originale", whose filter matches
// every raw variant. The facet distribution is capped at the first 100 values
// in alphabetical order, so genreSongsFilter also asks Meili's facet search
// for the values starting with the name (memoised 5 min per name).

import (
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// dottedAbbrev matches "B.O.", "O.S.T", "b.o.": letters separated by dots.
var dottedAbbrev = regexp.MustCompile(`^(\pL\.)+\pL?\.?$`)

// soundtrackGenre is the one display name of every soundtrack spelling.
const soundtrackGenre = "Bande originale"

// soundtrackKey matches a soundtrack spelling once lowercased, without
// leading "_", dots, and with "-" as a space: "b.o." -> "bo", "O.S.T" -> "ost".
var soundtrackKey = regexp.MustCompile(`^(?:(?:original|originele|film|movie|motion picture|game|video game|tv) )?(?:sound ?tracks?(?: score)?|score|ost|bso|bof?|bande originale(?: de film)?|banda sonora(?: original)?|colonna sonora)(?: \(.*\))?$`)

// soundtrackRawVariants are added to the "Bande originale" filter whatever
// the capped facet lists (Meili string filters are case-insensitive).
var soundtrackRawVariants = []string{
	"B.O.", "B.O.F.", "BSO", "OST", "O.S.T.", "Score", "Soundtrack", "Soundtracks", "Sound Track",
	"Original Soundtrack", "Original Score", "Film Score", "Soundtrack Score", "Soundtrack (Film)",
	"_Soundtrack", "Bande originale", "Bande originale de film", "Banda sonora",
}

// isSoundtrackName reports whether a clean name is a soundtrack spelling.
func isSoundtrackName(p string) bool {
	k := strings.ToLower(strings.TrimLeft(strings.TrimSpace(p), "_"))
	k = strings.ReplaceAll(k, ".", "")
	k = strings.ReplaceAll(k, "-", " ")
	k = strings.Join(strings.Fields(k), " ")
	return k != "" && soundtrackKey.MatchString(k)
}

// genreSlashWhole: slash names that are ONE genre (lowercase).
var genreSlashWhole = map[string]bool{
	"singer/songwriter": true,
	"ac/dc":             true,
	"r&b/soul":          true,
	"hip-hop/rap":       true,
	"hip hop/rap":       true,
}

// genreSlashMinSide: "/" splits only when every side has this many characters
// ("Electronic/House" splits, "AC/DC", "Rock/Pop", "R&B/Soul" do not).
const genreSlashMinSide = 4

func cleanGenrePart(p string) string { return strings.Join(strings.Fields(p), " ") }

// splitSlash splits one segment on "/" when the rules allow it.
func splitSlash(seg string) []string {
	if !strings.Contains(seg, "/") || genreSlashWhole[strings.ToLower(seg)] {
		return []string{seg}
	}
	parts := strings.Split(seg, "/")
	for i, p := range parts {
		parts[i] = cleanGenrePart(p)
		if utf8.RuneCountInString(parts[i]) < genreSlashMinSide {
			return []string{seg}
		}
	}
	return parts
}

// splitGenreValue returns the clean genre names held by one raw tag value.
func splitGenreValue(raw string) []string {
	segs := strings.FieldsFunc(raw, func(r rune) bool { return r == ';' || r == ',' || r == '|' })
	out := make([]string, 0, len(segs))
	for _, seg := range segs {
		seg = cleanGenrePart(seg)
		if seg == "" {
			continue
		}
		for _, p := range splitSlash(seg) {
			if isSoundtrackName(p) {
				out = append(out, soundtrackGenre)
				continue
			}
			if utf8.RuneCountInString(p) < 2 || strings.HasPrefix(p, "_") || dottedAbbrev.MatchString(p) {
				continue
			}
			out = append(out, p)
		}
	}
	return out
}

// genreKey is the comparison key of a clean genre name (soundtrack spellings
// all map to "bande originale").
func genreKey(name string) string {
	name = cleanGenrePart(name)
	if isSoundtrackName(name) {
		return strings.ToLower(soundtrackGenre)
	}
	return strings.ToLower(name)
}

type genreEntry struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// normalizeGenres turns the raw facet (value -> track count) into the
// deduplicated genre list, by count desc then name.
func normalizeGenres(raw map[string]int) []genreEntry {
	type acc struct {
		count    int
		spelling map[string]int
	}
	byKey := map[string]*acc{}
	for value, n := range raw {
		seen := map[string]bool{}
		for _, name := range splitGenreValue(value) {
			key := strings.ToLower(name)
			if seen[key] {
				continue // "Rock;rock" counts once
			}
			seen[key] = true
			a := byKey[key]
			if a == nil {
				a = &acc{spelling: map[string]int{}}
				byKey[key] = a
			}
			a.count += n
			a.spelling[name] += n
		}
	}
	out := make([]genreEntry, 0, len(byKey))
	for _, a := range byKey {
		best, bestN := "", -1
		for s, n := range a.spelling {
			if n > bestN || (n == bestN && s < best) {
				best, bestN = s, n
			}
		}
		out = append(out, genreEntry{Name: best, Count: a.count})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// rawGenresFor lists the raw facet values holding `name` (case-insensitive),
// sorted for a stable filter.
func rawGenresFor(name string, raw map[string]int) []string {
	key := genreKey(name)
	out := []string{}
	for value := range raw {
		for _, g := range splitGenreValue(value) {
			if genreKey(g) == key {
				out = append(out, value)
				break
			}
		}
	}
	sort.Strings(out)
	return out
}

// genreFilterFor builds the Meilisearch filter for a clean genre name: the
// exact match when the facet has nothing better (or only the value itself),
// `genre IN [...]` over every raw value that contains it otherwise.
func genreFilterFor(name string, raw map[string]int) string {
	values := rawGenresFor(name, raw)
	// Audit L11-1 (P1): the facet only exposes the first values (alphabetical, capped), so a
	// genre whose plain value is beyond the cap was reduced to its combined tags only
	// (Rock: 75 tracks instead of thousands). The exact name is ALWAYS part of the filter.
	hasExact := false
	for _, v := range values {
		if v == name {
			hasExact = true
			break
		}
	}
	if !hasExact {
		values = append(values, name)
	}
	// L11-6: "Bande originale" (or any soundtrack spelling) matches every variant.
	if genreKey(name) == strings.ToLower(soundtrackGenre) {
		have := map[string]bool{}
		for _, v := range values {
			have[strings.ToLower(v)] = true
		}
		for _, v := range soundtrackRawVariants {
			if !have[strings.ToLower(v)] {
				have[strings.ToLower(v)] = true
				values = append(values, v)
			}
		}
		sort.Strings(values)
	}
	if len(values) == 1 {
		return "genre = \"" + escapeMeili(name) + "\""
	}
	quoted := make([]string, len(values))
	for i, v := range values {
		quoted[i] = "\"" + escapeMeili(v) + "\""
	}
	return "genre IN [" + strings.Join(quoted, ", ") + "]"
}

// genreSongsFilter is the local/songs genre filter: the live facet (first
// 100 values, alphabetical) plus the facet-search values for the name.
func genreSongsFilter(name string) string {
	raw := genreTrackCounts()
	for v, n := range genreFacetSearchValues(name) {
		if _, ok := raw[v]; !ok {
			raw[v] = n
		}
	}
	return genreFilterFor(name, raw)
}

// genreFacetSearchTTL: how long the facet-search values of a name are reused.
const genreFacetSearchTTL = 5 * time.Minute

type genreFacetMemo struct {
	at   time.Time
	vals map[string]int
}

var (
	genreFacetMu    sync.Mutex
	genreFacetCache = map[string]genreFacetMemo{}
)

// genreFacetQueries: what to ask the facet search for a genre name (one
// query, or every soundtrack spelling for "Bande originale").
func genreFacetQueries(name string) []string {
	if genreKey(name) == strings.ToLower(soundtrackGenre) {
		return []string{"soundtrack", "sound track", "score", "bso", "b.o", "ost", "o.s.t", "bande originale", "original", "banda sonora", "film score"}
	}
	return []string{cleanGenrePart(name)}
}

// genreFacetSearchValues asks Meili's facet search (Meili >= 1.3, prefix match
// on the value with typo tolerance) for the raw genre values starting with the
// name, beyond the 100-value cap of the facet distribution. Hits are only
// candidates: rawGenresFor keeps the values that really hold the genre. nil
// when Meili refuses (older engine, no facet search): the caller keeps the
// facet distribution alone. Successful answers are memoised 5 min per name.
func genreFacetSearchValues(name string) map[string]int {
	key := genreKey(name)
	if key == "" {
		return nil
	}
	genreFacetMu.Lock()
	if m, ok := genreFacetCache[key]; ok && time.Since(m.at) < genreFacetSearchTTL {
		genreFacetMu.Unlock()
		return m.vals
	}
	genreFacetMu.Unlock()
	queries := genreFacetQueries(name)
	vals := map[string]int{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	failed := false
	for _, q := range queries {
		wg.Add(1)
		go func(q string) {
			defer wg.Done()
			out, err := meiliReq("POST", "/indexes/tracks/facet-search", map[string]interface{}{
				"facetName": "genre", "facetQuery": q,
			})
			mu.Lock()
			defer mu.Unlock()
			if err != nil || out == nil {
				failed = true
				return
			}
			hits, _ := out["facetHits"].([]interface{})
			for _, h := range hits {
				m, _ := h.(map[string]interface{})
				v, _ := m["value"].(string)
				if strings.TrimSpace(v) == "" {
					continue
				}
				vals[v] = mintFloat(m["count"])
			}
		}(q)
	}
	wg.Wait()
	if failed {
		// Not memoised: an older Meili (or a blip) is asked again next time.
		if len(vals) == 0 {
			return nil
		}
		return vals
	}
	genreFacetMu.Lock()
	genreFacetCache[key] = genreFacetMemo{at: time.Now(), vals: vals}
	genreFacetMu.Unlock()
	return vals
}

// resetGenreFacetCache empties the facet-search memo (tests).
func resetGenreFacetCache() {
	genreFacetMu.Lock()
	genreFacetCache = map[string]genreFacetMemo{}
	genreFacetMu.Unlock()
}
