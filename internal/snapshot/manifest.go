package snapshot

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
)

// ManifestFile is the index kept next to the response files. Nothing reads it at run time (responses are
// found by key); it says which place each file belongs to, so a snapshot can be reviewed and refreshed.
const ManifestFile = "manifest.json"

// PlaceRecord lists the responses recorded for one place.
type PlaceRecord struct {
	Name     string  `json:"name"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	Size     int     `json:"size"`     // detail area, m
	Far      int     `json:"far"`      // surroundings, m
	Recorded string  `json:"recorded"` // date, YYYY-MM-DD
	Files    []Entry `json:"files"`
}

// Manifest is the index of a snapshot directory.
type Manifest struct {
	Version int           `json:"version"`
	Places  []PlaceRecord `json:"places"`
}

// LoadManifest reads dir's manifest; a directory without one gives an empty manifest.
func LoadManifest(dir string) (Manifest, error) {
	m := Manifest{Version: 1}
	raw, err := os.ReadFile(filepath.Join(dir, ManifestFile))
	if errors.Is(err, os.ErrNotExist) {
		return m, nil
	}
	if err != nil {
		return m, err
	}
	err = json.Unmarshal(raw, &m)
	return m, err
}

// Set adds rec, replacing the record of the same place name.
func (m *Manifest) Set(rec PlaceRecord) {
	for i := range m.Places {
		if m.Places[i].Name == rec.Name {
			m.Places[i] = rec
			return
		}
	}
	m.Places = append(m.Places, rec)
}

// Save writes the manifest, places sorted by name, through a temporary file.
func (m Manifest) Save(dir string) error {
	sort.Slice(m.Places, func(i, j int) bool { return m.Places[i].Name < m.Places[j].Name })
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(raw, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(dir, ManifestFile))
}
