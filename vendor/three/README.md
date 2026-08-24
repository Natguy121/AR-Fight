# vendor/three

`three.module.js` is three.js **r169**, vendored verbatim from the npm package
`three@0.169.0` (`build/three.module.js`). It is committed so the app runs with
no build step and no CDN at runtime.

To update:

```sh
npm pack three@<version>
tar xzf three-<version>.tgz package/build/three.module.js
cp package/build/three.module.js vendor/three/three.module.js
```

Then bump the version note above and re-check `index.html`'s import map.
