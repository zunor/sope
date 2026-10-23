// SPDX-License-Identifier: MIT
// Run through scripts/test-go-embed.sh; no Go SQLite driver is needed.
package main

/*
#include <sope.h>
#include <stdlib.h>
*/
import "C"

import (
	"fmt"
	"os"
	"runtime"
	"strings"
	"unsafe"
)

func check(rc C.int) {
	if rc != C.SOPE_OK {
		panic(C.GoString(C.sope_last_error()))
	}
}

func main() {
	// sope_last_error is thread-local.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	dir, err := os.MkdirTemp("", "sope-go-embed-")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(dir)
	path := C.CString(dir)
	defer C.free(unsafe.Pointer(path))
	var agent *C.sope_agent_t
	check(C.sope_agent_open(&agent, path))
	for key, value := range map[string]string{"provider": "mock", "mock.delay_ms": "0"} {
		k, v := C.CString(key), C.CString(value)
		check(C.sope_agent_set_option(agent, k, v))
		C.free(unsafe.Pointer(k))
		C.free(unsafe.Pointer(v))
	}
	const input = "Go host with embedded SQLite"
	message := C.CString(input)
	check(C.sope_send(agent, message, C.size_t(len(input)), nil))
	C.free(unsafe.Pointer(message))
	for {
		var event C.sope_event_t
		event.size = C.uint32_t(unsafe.Sizeof(event))
		if C.sope_poll(agent, &event, 10000) != 1 || event._type == C.SOPE_EVENT_ERROR {
			panic("agent turn failed")
		}
		if event._type == C.SOPE_EVENT_TURN_END {
			break
		}
	}
	C.sope_agent_free(agent)
	check(C.sope_agent_open(&agent, path))
	defer C.sope_agent_free(agent)
	var history *C.char
	var length C.size_t
	check(C.sope_agent_history(agent, &history, &length))
	if !strings.Contains(C.GoStringN(history, C.int(length)), input) {
		panic("durable history lost after reopen")
	}
	fmt.Println("Go embedding: durable reopen passed")
}
