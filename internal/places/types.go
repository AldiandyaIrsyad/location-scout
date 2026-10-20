// Package places provides the built-in candidate list and place-name search (built-in list first,
// then Nominatim).
package places

import "context"

// Place is a named location. Group is the region a built-in candidate is listed under (empty for
// search results that are not in the built-in list).
type Place struct {
	Name  string  `json:"name"`
	Lat   float64 `json:"lat"`
	Lon   float64 `json:"lon"`
	Group string  `json:"group,omitempty"`
}

// Service lists candidates and searches places.
type Service interface {
	// Candidates returns the built-in list, in display order.
	Candidates() []Place
	// Search matches the built-in list, then appends Nominatim results (deduplicated). Upstream failure
	// is not an error: the local matches are returned.
	Search(ctx context.Context, query string) ([]Place, error)
}
