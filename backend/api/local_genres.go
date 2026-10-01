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

import (
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// dottedAbbrev matches "B.O.", "O.S.T", "b.o.": letters separated by dots.
var dottedAbbrev = regexp.MustCompile(`^(\pL\.)+\pL?\.?$`)

// splitGenreValue returns the clean genre names held by one raw tag value.
func splitGenreValue(raw string) []string {
	parts := strings.FieldsFunc(raw, func(r rune) bool { return r == ';' || r == '/' })
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.Join(strings.Fields(p), " ")
		if utf8.RuneCountInString(p) < 2 || strings.HasPrefix(p, "_") || dottedAbbrev.MatchString(p) {
			continue
		}
		out = append(out, p)
	}
	return out
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
	key := strings.ToLower(strings.Join(strings.Fields(name), " "))
	out := []string{}
	for value := range raw {
		for _, g := range splitGenreValue(value) {
			if strings.ToLower(g) == key {
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
	if len(values) == 0 || (len(values) == 1 && values[0] == name) {
		return "genre = \"" + escapeMeili(name) + "\""
	}
	quoted := make([]string, len(values))
	for i, v := range values {
		quoted[i] = "\"" + escapeMeili(v) + "\""
	}
	return "genre IN [" + strings.Join(quoted, ", ") + "]"
}

// genreSongsFilter is the local/songs genre filter (reads the live facet).
func genreSongsFilter(name string) string {
	return genreFilterFor(name, genreTrackCounts())
}
