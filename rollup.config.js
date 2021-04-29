import commonjs from '@rollup/plugin-commonjs'
import resolve from '@rollup/plugin-node-resolve'
import { terser } from 'rollup-plugin-terser'


const production = !process.env.ROLLUP_WATCH;

export default {
    input: 'src/index.js',
    output: {
        sourcemap: !production,
        dir: 'dist',
        format: 'esm',
    },
    plugins: [
        resolve({
            browser: true,
            preferBuiltins: false,
        }),
        commonjs(),
    ]
}
