// Package coords parses user-entered locations: map links (Google Maps / Earth, OpenStreetMap),
// decimal and DMS coordinates, Plus Codes, and place files (KML, KMZ, GeoJSON).
package coords

// Location is a parsed position. Optional fields are nil when absent.
type Location struct {
	Lat     float64  `json:"lat"`
	Lon     float64  `json:"lon"`
	Heading *float64 `json:"heading,omitempty"` // degrees, Google Earth view direction
	Tilt    *float64 `json:"tilt,omitempty"`    // degrees, 0 = straight down
	Range   *float64 `json:"range,omitempty"`   // meters from the camera to the point
	Name    string   `json:"name,omitempty"`
}
