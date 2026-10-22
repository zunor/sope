# BundledCurl.cmake - builds libcurl and mbedTLS from source as static,
# position-independent archives, so libsope carries its own HTTP/TLS stack
# (SOPE_CURL=bundled). Only HTTP(S) is enabled. Defines the INTERFACE target
# `sope_curl` and the list SOPE_BUNDLED_ARCHIVES.
#
# The tarballs are downloaded at build time and checked against pinned
# SHA-256 sums. Point SOPE_CURL_URL / SOPE_MBEDTLS_URL at local copies to
# build offline.

include(ExternalProject)

set(SOPE_MBEDTLS_URL "https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.7/mbedtls-3.6.7.tar.bz2"
    CACHE STRING "mbedTLS source tarball (URL or path)")
set(SOPE_MBEDTLS_SHA256 "a7e8bcbec0e6f761b4af24f25677626b35f762f68eef79c08677a363212d11f6")
set(SOPE_CURL_URL "https://github.com/curl/curl/releases/download/curl-8_23_0/curl-8.23.0.tar.xz"
    CACHE STRING "curl source tarball (URL or path)")
set(SOPE_CURL_SHA256 "8dadd7d2536a314f982ad05a651b713f426bf7d02cc2c76cffb9796f2218e6c5")

set(_deps "${CMAKE_BINARY_DIR}/deps")
set(_lib "${_deps}/lib")
set(_mbedtls_libs "${_lib}/libmbedtls.a" "${_lib}/libmbedx509.a" "${_lib}/libmbedcrypto.a")
set(_curl_lib "${_lib}/libcurl.a")

set(_common_args
  -DCMAKE_INSTALL_PREFIX=${_deps}
  -DCMAKE_INSTALL_LIBDIR=lib
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON
  -DCMAKE_C_VISIBILITY_PRESET=hidden
  -DCMAKE_C_COMPILER=${CMAKE_C_COMPILER}
  -DCMAKE_OSX_ARCHITECTURES=${CMAKE_OSX_ARCHITECTURES}
  -DCMAKE_OSX_DEPLOYMENT_TARGET=${CMAKE_OSX_DEPLOYMENT_TARGET})

ExternalProject_Add(mbedtls_ep
  URL "${SOPE_MBEDTLS_URL}"
  URL_HASH SHA256=${SOPE_MBEDTLS_SHA256}
  DOWNLOAD_EXTRACT_TIMESTAMP ON
  CMAKE_ARGS ${_common_args}
    -DENABLE_TESTING=OFF
    -DENABLE_PROGRAMS=OFF
    -DGEN_FILES=OFF
    -DMBEDTLS_FATAL_WARNINGS=OFF
    -DUSE_SHARED_MBEDTLS_LIBRARY=OFF
    -DUSE_STATIC_MBEDTLS_LIBRARY=ON
  BUILD_BYPRODUCTS ${_mbedtls_libs})

ExternalProject_Add(curl_ep
  URL "${SOPE_CURL_URL}"
  URL_HASH SHA256=${SOPE_CURL_SHA256}
  DOWNLOAD_EXTRACT_TIMESTAMP ON
  DEPENDS mbedtls_ep
  CMAKE_ARGS ${_common_args}
    -DBUILD_SHARED_LIBS=OFF
    -DBUILD_STATIC_LIBS=ON
    -DBUILD_CURL_EXE=OFF
    -DBUILD_TESTING=OFF
    -DBUILD_EXAMPLES=OFF
    -DBUILD_LIBCURL_DOCS=OFF
    -DBUILD_MISC_DOCS=OFF
    -DENABLE_CURL_MANUAL=OFF
    -DCURL_ENABLE_SSL=ON
    -DCURL_USE_MBEDTLS=ON
    -DCURL_USE_OPENSSL=OFF
    -DMBEDTLS_INCLUDE_DIR=${_deps}/include
    -DMBEDTLS_LIBRARY=${_lib}/libmbedtls.a
    -DMBEDX509_LIBRARY=${_lib}/libmbedx509.a
    -DMBEDCRYPTO_LIBRARY=${_lib}/libmbedcrypto.a
    # The CA bundle is located at run time (see http.c), not baked in.
    -DCURL_CA_BUNDLE=none
    -DCURL_CA_PATH=none
    -DCURL_DISABLE_CA_SEARCH=ON
    # HTTP(S) only, no optional dependencies.
    -DUSE_NGHTTP2=OFF -DUSE_LIBIDN2=OFF -DUSE_APPLE_IDN=OFF -DCURL_USE_LIBPSL=OFF -DCURL_USE_LIBSSH2=OFF
    -DCURL_USE_GSSAPI=OFF -DCURL_ZLIB=OFF -DCURL_BROTLI=OFF -DCURL_ZSTD=OFF -DENABLE_ARES=OFF
    -DCURL_DISABLE_LDAP=ON -DCURL_DISABLE_LDAPS=ON -DCURL_DISABLE_FTP=ON -DCURL_DISABLE_FILE=ON
    -DCURL_DISABLE_DICT=ON -DCURL_DISABLE_GOPHER=ON -DCURL_DISABLE_IMAP=ON -DCURL_DISABLE_POP3=ON
    -DCURL_DISABLE_SMTP=ON -DCURL_DISABLE_RTSP=ON -DCURL_DISABLE_TELNET=ON -DCURL_DISABLE_TFTP=ON
    -DCURL_DISABLE_MQTT=ON -DCURL_DISABLE_IPFS=ON -DCURL_DISABLE_WEBSOCKETS=ON -DCURL_DISABLE_COOKIES=ON
    -DCURL_DISABLE_ALTSVC=ON -DCURL_DISABLE_HSTS=ON -DCURL_DISABLE_NETRC=ON -DCURL_DISABLE_DOH=ON
    -DCURL_DISABLE_AWS=ON -DCURL_DISABLE_KERBEROS_AUTH=ON -DCURL_DISABLE_NEGOTIATE_AUTH=ON
    -DCURL_DISABLE_INSTALL=OFF
  BUILD_BYPRODUCTS ${_curl_lib})

file(MAKE_DIRECTORY "${_deps}/include")

set(SOPE_BUNDLED_ARCHIVES ${_curl_lib} ${_mbedtls_libs})

add_library(sope_curl INTERFACE)
target_include_directories(sope_curl INTERFACE "${_deps}/include")
target_compile_definitions(sope_curl INTERFACE CURL_STATICLIB SOPE_CURL_BUNDLED)
target_link_libraries(sope_curl INTERFACE ${SOPE_BUNDLED_ARCHIVES})
if(APPLE)
  target_link_libraries(sope_curl INTERFACE
    "-framework SystemConfiguration" "-framework CoreFoundation" "-framework CoreServices")
endif()
