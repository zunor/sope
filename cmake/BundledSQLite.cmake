# SPDX-License-Identifier: MIT
# SQLite is part of both libsope artifacts, never a host link dependency.
include(FetchContent)
if(POLICY CMP0135)
  cmake_policy(SET CMP0135 NEW)
endif()
set(SOPE_SQLITE_URL "https://sqlite.org/2026/sqlite-amalgamation-3540100.zip"
    CACHE STRING "SQLite amalgamation archive (URL or local path)")
FetchContent_Declare(sope_sqlite_source
  URL "${SOPE_SQLITE_URL}"
  URL_HASH SHA3_256=92281c86e2957f9b9305890f9ac04204caa7b677cc868dc326d942689df28e30)
FetchContent_MakeAvailable(sope_sqlite_source)

# Namespace the complete public header, including types and exported data.
# Hidden visibility alone does not prevent static-link collisions with a host
# that embeds its own SQLite (for example a Go SQLite driver or Bun).
file(READ "${sope_sqlite_source_SOURCE_DIR}/sqlite3.h" _sqlite_header)
string(REGEX MATCHALL "sqlite3[a-zA-Z0-9_]*" _sqlite_names "${_sqlite_header}")
list(REMOVE_DUPLICATES _sqlite_names)
set(_sqlite_prefix "/* Generated private SQLite namespace. */\n#pragma once\n")
foreach(_name IN LISTS _sqlite_names)
  string(APPEND _sqlite_prefix "#define ${_name} sope__${_name}\n")
endforeach()
set(_sqlite_generated "${CMAKE_CURRENT_BINARY_DIR}/sqlite-private")
file(MAKE_DIRECTORY "${_sqlite_generated}")
file(CONFIGURE OUTPUT "${_sqlite_generated}/sope_sqlite_names.h" CONTENT "${_sqlite_prefix}" @ONLY)
file(CONFIGURE OUTPUT "${_sqlite_generated}/sope_sqlite.h"
  CONTENT "#include \"sope_sqlite_names.h\"\n#include \"sqlite3.h\"\n" @ONLY)
file(CONFIGURE OUTPUT "${_sqlite_generated}/sope_sqlite.c"
  CONTENT "#include \"sope_sqlite_names.h\"\n#include \"sqlite3.c\"\n" @ONLY)

add_library(sope_sqlite_headers INTERFACE)
target_include_directories(sope_sqlite_headers INTERFACE
  "${_sqlite_generated}" "${sope_sqlite_source_SOURCE_DIR}")
add_library(sope_sqlite OBJECT "${_sqlite_generated}/sope_sqlite.c")
target_link_libraries(sope_sqlite PRIVATE sope_sqlite_headers Threads::Threads)
target_compile_definitions(sope_sqlite PRIVATE SQLITE_THREADSAFE=1 SQLITE_OMIT_LOAD_EXTENSION)
if(CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
  target_compile_options(sope_sqlite PRIVATE -w) # upstream amalgamation, not sope source
endif()
