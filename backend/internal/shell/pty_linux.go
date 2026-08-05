//go:build linux

package shell

import (
	"errors"
	"os"
	"syscall"
	"unsafe"
)

// ioctl constants for the Linux PTY API.
const (
	sysTIOCSPTLCK  = 0x40045431 // unlockpt:  _IOW('T', 0x31, int)
	sysTIOCGPTPEER = 0x80045438 // TIOCGPTPEER: open the subordinate end
	sysTIOCSWINSZ  = 0x5414     // set window size
)

// winsize mirrors the struct winsize from <termios.h>.
type winsize struct {
	Row    uint16
	Col    uint16
	Xpixel uint16
	Ypixel uint16
}

// openPTY allocates a new pseudo-terminal pair using /dev/ptmx.
// It returns a *os.File for the master end and the path of the slave.
func openPTY() (*os.File, string, error) {
	// Open /dev/ptmx with O_RDWR | O_NOCTTY so we don't accidentally make it
	// our controlling tty.
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return nil, "", err
	}

	// Unlock the slave so a non-root process can open it.
	var unlock int = 0
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, master.Fd(),
		uintptr(sysTIOCSPTLCK), uintptr(unsafe.Pointer(&unlock)))
	if errno != 0 {
		master.Close()
		return nil, "", errors.New("unlockpt failed: " + errno.Error())
	}

	// Derive the slave path: /dev/pts/<n>.
	// On modern Linux we can stat the master to learn its number, but the
	// most portable way is to read it via TIOCGPTN. We fall back to
	// TIOCGPTPEER-free path derivation using fstat.
	var ptyno uint32
	_, _, errno = syscall.Syscall(syscall.SYS_IOCTL, master.Fd(),
		uintptr(0x80045430), uintptr(unsafe.Pointer(&ptyno))) // TIOCGPTN
	if errno != 0 {
		master.Close()
		return nil, "", errors.New("TIOCGPTN failed: " + errno.Error())
	}
	slavePath := "/dev/pts/" + itoa(int(ptyno))

	return master, slavePath, nil
}

// setWinSize updates the terminal dimensions of the slave end.
func setWinSize(master *os.File, rows, cols int) error {
	if master == nil || rows <= 0 || cols <= 0 {
		return nil
	}
	ws := winsize{Row: uint16(rows), Col: uint16(cols)}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, master.Fd(),
		uintptr(sysTIOCSWINSZ), uintptr(unsafe.Pointer(&ws)))
	if errno != 0 {
		return errors.New("TIOCSWINSZ failed: " + errno.Error())
	}
	return nil
}
