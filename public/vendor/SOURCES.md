# Vue browser builds

The application uses the full production build of Vue **3.5.39**, including the
runtime template compiler. The development build remains available for existing
template validation tests.

- Package: `https://registry.npmjs.org/vue/3.5.39`
- Archive: `https://registry.npmjs.org/vue/-/vue-3.5.39.tgz`
- Extracted file: `package/dist/vue.global.prod.js`
- License: MIT; the upstream copyright and license header is preserved.
- Verified archive integrity (SHA-512, base64):
  `xmZCYabFGcirU8r0fTuvl/LICc1OU620rnqepaJDL/a141ZigkG7AyaxQLdqJ02ZRYzWe6YPaDHeQx7MfknQfA==`
- Production file SHA-256:
  `349cb8e0ede3449b4962458daa03418518af50b4a9959a552cce35a8bec92805`

The development and production builds must stay on the same Vue version when
updating these assets. No CDN request is needed at runtime.
