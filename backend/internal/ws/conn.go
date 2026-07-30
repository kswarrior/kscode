package ws

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strings"
)

const (
	OpcodeContinuation = 0x0
	OpcodeText         = 0x1
	OpcodeBinary       = 0x2
	OpcodeClose        = 0x8
	OpcodePing         = 0x9
	OpcodePong         = 0xa
)

var magicGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type Conn struct {
	conn net.Conn
	br   *bufio.Reader
	bw   *bufio.Writer
}

func Upgrade(raw net.Conn, key string) (*Conn, error) {
	h := sha1.New()
	h.Write([]byte(key + magicGUID))
	accept := base64.StdEncoding.EncodeToString(h.Sum(nil))
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
	if _, err := raw.Write([]byte(resp)); err != nil {
		return nil, err
	}
	return &Conn{conn: raw, br: bufio.NewReader(raw), bw: bufio.NewWriter(raw)}, nil
}

type Frame struct {
	Fin    bool
	Op     byte
	Masked bool
	Mask   [4]byte
	Payload []byte
}

func (c *Conn) ReadFrame() (*Frame, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(c.br, hdr[:]); err != nil {
		return nil, err
	}
	f := &Frame{
		Fin: hdr[0]&0x80 != 0,
		Op:  hdr[0] & 0x0f,
	}
	masked := hdr[1]&0x80 != 0
	length := int64(hdr[1] & 0x7f)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return nil, err
		}
		length = int64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return nil, err
		}
		length = int64(binary.BigEndian.Uint64(ext[:]))
	}
	if masked {
		f.Masked = true
		if _, err := io.ReadFull(c.br, f.Mask[:]); err != nil {
			return nil, err
		}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(c.br, payload); err != nil {
		return nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= f.Mask[i%4]
		}
	}
	f.Payload = payload
	return f, nil
}

func (c *Conn) Write(op byte, data []byte) error {
	var hdr [2]byte
	hdr[0] = 0x80 | op
	n := len(data)
	switch {
	case n < 126:
		hdr[1] = byte(n)
	case n < 65536:
		hdr[1] = 126
	default:
		hdr[1] = 127
	}
	if _, err := c.bw.Write(hdr[:]); err != nil {
		return err
	}
	if n >= 126 && n < 65536 {
		var ext [2]byte
		binary.BigEndian.PutUint16(ext[:], uint16(n))
		if _, err := c.bw.Write(ext[:]); err != nil {
			return err
		}
	} else if n >= 65536 {
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(n))
		if _, err := c.bw.Write(ext[:]); err != nil {
			return err
		}
	}
	if _, err := c.bw.Write(data); err != nil {
		return err
	}
	return c.bw.Flush()
}

func (c *Conn) WriteText(s string) error {
	return c.Write(OpcodeText, []byte(s))
}

func (c *Conn) WriteJSON(v any) error {
	return errors.New("use WriteText with marshaled JSON")
}

func (c *Conn) Close() error {
	return c.conn.Close()
}

func ParseKey(header string) string {
	for _, line := range strings.Split(header, "\r\n") {
		if strings.HasPrefix(strings.ToLower(line), "sec-websocket-key:") {
			return strings.TrimSpace(line[len("sec-websocket-key:"):])
		}
	}
	return ""
}
