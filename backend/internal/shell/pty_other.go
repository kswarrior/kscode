//go:build !linux

package shell

import (
	"errors"
	"os"
)

// Stub PTY implementation for non-Linux platforms. The terminal feature
// degrades to plain pipes on these systems; this keeps the package compiling.
func openPTY() (*os.File, string, error) {
	return nil, "", errors.New("pty: only supported on linux")
}

func setWinSize(master *os.File, rows, cols int) error {
	return nil
}
