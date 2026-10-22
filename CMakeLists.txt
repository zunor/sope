# SPDX-License-Identifier: MIT
cmake_minimum_required(VERSION 3.20)

# include/sope.h is the single source of the version.
file(STRINGS include/sope.h _version_lines REGEX "^#define SOPE_VERSION_(MAJOR|MINOR|PATCH) ")
foreach(_line ${_version_lines})
  string(REGEX MATCH "SOPE_VERSION_([A-Z]+) +([0-9]+)" _ "${_line}")
  set(_SOPE_${CMAKE_MATCH_1} ${CMAKE_MATCH_2})
endforeach()
project(sope VERSION ${_SOPE_MAJOR}.${_SOPE_MINOR}.${_SOPE_PATCH} LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)
set(CMAKE_C_VISIBILITY_PRESET hidden)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(SOPE_BUILD_TESTS "Build the C test suite" ON)
option(SOPE_BUILD_EXAMPLES "Build the C examples" ON)
set(SOPE_SANITIZE "" CACHE STRING "Sanitizer to build with: address, thread, undefined, or empty")
set(SOPE_CURL "system" CACHE STRING
    "HTTP backend: system (link the system libcurl), bundled (build curl + mbedTLS into libsope), off (mock provider only)")
set_property(CACHE SOPE_CURL PROPERTY STRINGS system bundled off)

find_package(Threads REQUIRED)

if(CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
  add_compile_options(-Wall -Wextra -Wpedantic -Wshadow -Wstrict-prototypes -Wmissing-prototypes)
endif()

if(SOPE_SANITIZE)
  add_compile_options(-fsanitize=${SOPE_SANITIZE} -fno-omit-frame-pointer -g)
  add_link_options(-fsanitize=${SOPE_SANITIZE})
endif()

if(SOPE_CURL STREQUAL "system")
  find_package(CURL REQUIRED)
  add_library(sope_curl INTERFACE)
  target_link_libraries(sope_curl INTERFACE CURL::libcurl)
elseif(SOPE_CURL STREQUAL "bundled")
  include(cmake/BundledCurl.cmake)
elseif(NOT SOPE_CURL STREQUAL "off")
  message(FATAL_ERROR "SOPE_CURL must be system, bundled or off (got '${SOPE_CURL}')")
endif()

set(SOPE_SOURCES
  src/agent.c
  src/compact.c
  src/http.c
  src/json.c
  src/loop.c
  src/pool.c
  src/provider_mock.c
  src/proc.c
  src/provider_openai.c
  src/search.c
  src/tools.c
  src/util.c
  src/web.c
)

add_library(sope SHARED ${SOPE_SOURCES})
add_library(sope_static STATIC ${SOPE_SOURCES})
set_target_properties(sope PROPERTIES VERSION ${PROJECT_VERSION} SOVERSION ${PROJECT_VERSION_MAJOR})
set_target_properties(sope_static PROPERTIES OUTPUT_NAME sope)
target_compile_definitions(sope PRIVATE SOPE_BUILD_SHARED)

foreach(target sope sope_static)
  target_include_directories(${target}
    PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include
    PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
  target_link_libraries(${target} PUBLIC Threads::Threads)
  if(NOT SOPE_CURL STREQUAL "off")
    target_compile_definitions(${target} PRIVATE SOPE_WITH_CURL)
    if(SOPE_CURL STREQUAL "bundled")
      add_dependencies(${target} curl_ep)
    endif()
  endif()
endforeach()
if(NOT SOPE_CURL STREQUAL "off")
  target_link_libraries(sope PRIVATE sope_curl)
  # A static archive cannot hide its dependencies: consumers link them too.
  target_link_libraries(sope_static PUBLIC sope_curl)
endif()

# The shared library exports the public sope_* API (internal symbols are
# sope__*) and nothing else, bundled curl included.
if(APPLE)
  file(WRITE ${CMAKE_BINARY_DIR}/sope.exports "_sope_[a-z]*\n")
  target_link_options(sope PRIVATE "LINKER:-exported_symbols_list,${CMAKE_BINARY_DIR}/sope.exports" "LINKER:-dead_strip")
elseif(UNIX)
  file(WRITE ${CMAKE_BINARY_DIR}/sope.map "{ global: sope_[a-z]*; local: *; };\n")
  target_link_options(sope PRIVATE "LINKER:--version-script=${CMAKE_BINARY_DIR}/sope.map" "LINKER:--gc-sections")
endif()

# With bundled curl, libsope-bundled.a is a single relocatable object holding
# sope, curl and mbedTLS, with every symbol but sope_* made local: a static
# drop-in that cannot clash with a host's own curl or TLS library.
if(SOPE_CURL STREQUAL "bundled" AND UNIX)
  set(_amalgam_o ${CMAKE_BINARY_DIR}/sope-bundled.o)
  set(_amalgam_a ${CMAKE_BINARY_DIR}/libsope-bundled.a)
  if(APPLE)
    set(_force_load)
    foreach(_a ${SOPE_BUNDLED_ARCHIVES})
      list(APPEND _force_load -Wl,-force_load,${_a})
    endforeach()
    # The compiler driver supplies -arch for the partial link.
    add_custom_command(OUTPUT ${_amalgam_a}
      COMMAND ${CMAKE_C_COMPILER} -r -nostdlib -o ${_amalgam_o}
              -Wl,-exported_symbols_list,${CMAKE_BINARY_DIR}/sope.exports
              -Wl,-force_load,$<TARGET_FILE:sope_static> ${_force_load}
      COMMAND ${CMAKE_COMMAND} -E rm -f ${_amalgam_a}
      COMMAND libtool -static -o ${_amalgam_a} ${_amalgam_o}
      DEPENDS sope_static curl_ep
      VERBATIM)
  else()
    add_custom_command(OUTPUT ${_amalgam_a}
      COMMAND ${CMAKE_C_COMPILER} -r -nostdlib -o ${_amalgam_o}
              -Wl,--whole-archive $<TARGET_FILE:sope_static> ${SOPE_BUNDLED_ARCHIVES} -Wl,--no-whole-archive
      COMMAND objcopy -w --keep-global-symbol=sope_[a-z]* ${_amalgam_o}
      COMMAND ${CMAKE_COMMAND} -E rm -f ${_amalgam_a}
      COMMAND ${CMAKE_AR} rcs ${_amalgam_a} ${_amalgam_o}
      DEPENDS sope_static curl_ep
      VERBATIM)
  endif()
  add_custom_target(sope_bundled_archive ALL DEPENDS ${_amalgam_a})
endif()

if(SOPE_BUILD_TESTS)
  enable_testing()
  add_executable(test_agent tests/test_agent.c)
  target_link_libraries(test_agent PRIVATE sope_static)
  add_test(NAME agent COMMAND test_agent)
  add_executable(test_json tests/test_json.c)
  target_link_libraries(test_json PRIVATE sope_static)
  add_test(NAME json COMMAND test_json)
  add_executable(test_tools tests/test_tools.c)
  target_link_libraries(test_tools PRIVATE sope_static)
  add_test(NAME tools COMMAND test_tools)
endif()

if(SOPE_BUILD_EXAMPLES)
  add_executable(hello examples/hello.c)
  target_link_libraries(hello PRIVATE sope)
  add_executable(multiplex examples/multiplex.c)
  target_link_libraries(multiplex PRIVATE sope)
endif()

include(GNUInstallDirs)
install(TARGETS sope sope_static)
install(FILES include/sope.h DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
