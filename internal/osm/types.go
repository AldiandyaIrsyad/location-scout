// Package osm turns OpenStreetMap data (from the Overpass API) into a CityData model the browser
// renders: buildings with heights, roads, railways, water, green areas, trees and camera viewpoints.
package osm

import (
	"context"

	"panelscape/internal/geo"
)

// Service builds cities. Implementations cache upstream responses and parsed results.
type Service interface {
	// City returns the area of side size meters around (lat, lon). seed re-rolls guessed heights (0 = default).
	City(ctx context.Context, lat, lon float64, size int, seed int) (*CityData, error)
	// Surroundings returns simplified building footprints in the farSize square, outside the inner size square.
	Surroundings(ctx context.Context, lat, lon float64, size, farSize int) (*Surroundings, error)
}

// LatLon is a geographic position.
type LatLon struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

// CityData is the JSON document served by /api/city. Coordinates are local meters (x east, y north).
type CityData struct {
	Center     LatLon         `json:"center"`
	Size       int            `json:"size"`
	Seed       int            `json:"seed"`
	Buildings  []Building     `json:"buildings"`
	Roads      []Road         `json:"roads"`
	Railways   []Railway      `json:"railways"`
	Water      []Area         `json:"water"`
	Green      []Area         `json:"green"`
	Areas      []Area         `json:"areas"`
	Trees      []geo.Point    `json:"trees"`
	Props      []MappedObject `json:"props"`
	Viewpoints []Viewpoint    `json:"viewpoints"`
	Stats      Stats          `json:"stats"`
}

// Area is a polygon; outer ring counter-clockwise, holes clockwise.
type Area struct {
	ID    string        `json:"id"`
	Outer []geo.Point   `json:"outer"`
	Holes [][]geo.Point `json:"holes"`
	Kind  string        `json:"kind"`
}

// MappedObject is a small mapped landmark or point feature such as a statue,
// memorial, monument, or fountain. Position is local [x, y] metres from the
// city centre; Outer is present for mapped polygon features.
type MappedObject struct {
	ID       string      `json:"id"`
	Name     string      `json:"name"`
	Kind     string      `json:"kind"`
	Position geo.Point   `json:"position"`
	Height   float64     `json:"height"`
	Guessed  bool        `json:"guessed"`
	Outer    []geo.Point `json:"outer,omitempty"`
	Material string      `json:"material,omitempty"`
}

// Building is an extruded footprint.
type Building struct {
	ID         string        `json:"id"`
	Outer      []geo.Point   `json:"outer"`
	Holes      [][]geo.Point `json:"holes"`
	Height     float64       `json:"height"`     // meters, top of walls (incl. roof)
	MinHeight  float64       `json:"minHeight"`  // meters
	RoofShape  string        `json:"roofShape"`  // flat, gabled, hipped, pyramidal, ...
	RoofHeight float64       `json:"roofHeight"` // meters (0 for flat)
	Levels     *float64      `json:"levels"`     // building:levels, or null
	Kind       string        `json:"kind"`       // building tag value
	Guessed    bool          `json:"guessed"`    // height was guessed (re-rollable)
	Color      *string       `json:"color"`      // building:colour, or null
}

// Road is a highway polyline, clipped to the padded area.
type Road struct {
	ID     string      `json:"id"`
	Points []geo.Point `json:"points"`
	Kind   string      `json:"kind"` // highway value
	Width  float64     `json:"width"`
	Lanes  *float64    `json:"lanes"`
	Name   string      `json:"name"`
	Bridge bool        `json:"bridge"`
	Tunnel bool        `json:"tunnel"`
	Layer  int         `json:"layer"`
}

// Railway is a rail polyline, clipped to the padded area.
type Railway struct {
	ID     string      `json:"id"`
	Points []geo.Point `json:"points"`
	Kind   string      `json:"kind"`
	Name   string      `json:"name"`
	Bridge bool        `json:"bridge"`
	Tunnel bool        `json:"tunnel"`
	Layer  int         `json:"layer"`
}

// Viewpoint is a suggested camera position.
type Viewpoint struct {
	Label     string    `json:"label"`     // English label, e.g. "Crossing 1 A × B" (the UI re-labels by kind)
	Kind      string    `json:"kind"`      // crossing | street-eye | street-low | street-down
	Position  geo.Point `json:"position"`  // where the camera stands
	Target    geo.Point `json:"target"`    // what it looks at
	EyeHeight float64   `json:"eyeHeight"` // meters above ground
}

// Stats summarises a build.
type Stats struct {
	Buildings   int `json:"buildings"`
	Guessed     int `json:"guessed"`
	Roads       int `json:"roads"`
	Trees       int `json:"trees"`
	MappedTrees int `json:"mappedTrees"`
	Bytes       int `json:"bytes"` // size of the raw Overpass response
}

// Surroundings is the JSON document served by /api/surroundings.
type Surroundings struct {
	Buildings   []Building     `json:"buildings"`
	Roads       []Road         `json:"roads"`
	Railways    []Railway      `json:"railways"`
	Water       []Area         `json:"water"`
	Green       []Area         `json:"green"`
	Areas       []Area         `json:"areas"`
	Trees       []geo.Point    `json:"trees"`
	Props       []MappedObject `json:"props"`
	ContextSize int            `json:"contextSize"`
}
