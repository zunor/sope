cmake_minimum_required(VERSION 3.16)
project(sope VERSION 0.2.0 LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)
set(CMAKE_C_VISIBILITY_PRESET hidden)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(SOPE_BUILD_TESTS "Build the C test suite" ON)
option(SOPE_BUILD_EXAMPLES "Build the C examples" ON)
set(SOPE_SANITIZE "" CACHE STRING "Sanitizer to build with: address, thread, undefined, or empty")

find_package(Threads REQUIRED)

if(CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
  add_compile_options(-Wall -Wextra -Wpedantic -Wshadow -Wstrict-prototypes -Wmissing-prototypes)
endif()

if(SOPE_SANITIZE)
  add_compile_options(-fsanitize=${SOPE_SANITIZE} -fno-omit-frame-pointer -g)
  add_link_options(-fsanitize=${SOPE_SANITIZE})
endif()

option(SOPE_WITH_CURL "Use libcurl for HTTP (needed by the openai provider)" ON)

set(SOPE_SOURCES
  src/agent.c
  src/http.c
  src/json.c
  src/loop.c
  src/pool.c
  src/provider_mock.c
  src/provider_openai.c
  src/util.c
)

if(SOPE_WITH_CURL)
  find_package(CURL REQUIRED)
endif()

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
  if(SOPE_WITH_CURL)
    target_compile_definitions(${target} PRIVATE SOPE_WITH_CURL)
    target_link_libraries(${target} PRIVATE CURL::libcurl)
  endif()
endforeach()

if(SOPE_BUILD_TESTS)
  enable_testing()
  add_executable(test_agent tests/test_agent.c)
  target_link_libraries(test_agent PRIVATE sope_static)
  add_test(NAME agent COMMAND test_agent)
  add_executable(test_json tests/test_json.c)
  target_link_libraries(test_json PRIVATE sope_static)
  add_test(NAME json COMMAND test_json)
endif()

if(SOPE_BUILD_EXAMPLES)
  add_executable(hello examples/hello.c)
  target_link_libraries(hello PRIVATE sope)
  add_executable(multiplex examples/multiplex.c)
  target_link_libraries(multiplex PRIVATE sope)
endif()
