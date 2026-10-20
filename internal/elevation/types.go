// Package elevation builds terrain height grids from map tiles: GSI (Japan, 5 m then 10 m) and
// Terrarium (worldwide fallback).
package elevation

import "context"

// Service builds height grids. Implementations cache tiles and finished grids.
type Service interface {
	// Grid returns an n×n grid covering the size×size meter square centered on (lat, lon).
	Grid(ctx context.Context, lat, lon float64, size float64, n int) (*Grid, error)
}

// Grid is the JSON document served by /api/elevation.
// Heights are relative to the center (center = 0). index = i + j*n; i: west→east, j: north→south.
// When no tile could be loaded the grid is flat (all zeros) and Source is "".
type Grid struct {
	Size          float64   `json:"size"`
	N             int       `json:"n"`
	Heights       []float32 `json:"heights"`
	BaseElevation float64   `json:"baseElevation"` // absolute meters at the center
	Source        string    `json:"source"`        // e.g. "GSI 5 m + GSI 10 m" or "Terrain Tiles"
}
