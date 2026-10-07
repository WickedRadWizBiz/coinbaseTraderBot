{
    'targets': [{
        'target_name': 'talib',
        'sources': [
            'src/talib.cpp'
        ],
        "include_dirs": [
            "<!(node -e \"require('nan')\")"
        ],
        'conditions': [
            ['OS=="linux"', {
                "libraries": [
                    "../src/lib/lib/libta_abstract_csr.a",
                    "../src/lib/lib/libta_func_csr.a",
                    "../src/lib/lib/libta_common_csr.a",
                    "../src/lib/lib/libta_libc_csr.a",
                ]
            }],
            ['OS=="freebsd"', {
                "libraries": [
                    "/usr/local/lib/libta_lib.a"
                ]
            }],
            ['OS=="mac"', {
                'xcode_settings': {
                    'MACOSX_DEPLOYMENT_TARGET': '10.9',
                    'GCC_ENABLE_CPP_EXCEPTIONS': 'YES'
                },
                "libraries": [
                    "../src/lib/lib/libta_abstract_csr.a",
                    "../src/lib/lib/libta_func_csr.a",
                    "../src/lib/lib/libta_common_csr.a",
                    "../src/lib/lib/libta_libc_csr.a",
                ]
            }],
            ['OS=="win"', {
                # The TA-Lib C sources compiled into the addon (no separate MSBuild solution in this vendored copy).
                "sources": ["<!@(node src/lib/win_sources.js)"],
                "include_dirs": [
                    "src/lib/include",
                    "src/lib/src/ta_common",
                    "src/lib/src/ta_func",
                    "src/lib/src/ta_abstract",
                    "src/lib/src/ta_abstract/tables",
                    "src/lib/src/ta_abstract/frames"
                ],
                "defines": ["TA_SINGLE_THREAD", "_CRT_SECURE_NO_WARNINGS"]
            }],
        ]
    }]
}
