// Package geo converts between latitude/longitude and local meters.
// Local [x, y] = [east, north] meters from the origin (lat0, lon0), equirectangular.
package geo

import "math"

// MetersPerDegLat is the length of one degree of latitude in meters.
const MetersPerDegLat = 110574.0

// MetersPerDegLon returns the length of one degree of longitude at latitude lat.
func MetersPerDegLon(lat float64) float64 {
	return 111320 * math.Cos(lat*math.Pi/180)
}

// Point is a local [x, y] position in meters (x east, y north).
type Point [2]float64

// ToLocal converts (lat, lon) to local meters around (lat0, lon0).
func ToLocal(lat, lon, lat0, lon0 float64) Point {
	return Point{(lon - lon0) * MetersPerDegLon(lat0), (lat - lat0) * MetersPerDegLat}
}

// ToLatLon converts local meters around (lat0, lon0) back to (lat, lon).
func ToLatLon(x, y, lat0, lon0 float64) (lat, lon float64) {
	return lat0 + y/MetersPerDegLat, lon0 + x/MetersPerDegLon(lat0)
}

// BBox is a geographic bounding box in degrees.
type BBox struct {
	South, West, North, East float64
}

// BBoxFor returns the square of side sizeMeters centered on (lat0, lon0).
func BBoxFor(lat0, lon0, sizeMeters float64) BBox {
	half := sizeMeters / 2
	dLat := half / MetersPerDegLat
	dLon := half / MetersPerDegLon(lat0)
	return BBox{South: lat0 - dLat, West: lon0 - dLon, North: lat0 + dLat, East: lon0 + dLon}
}
