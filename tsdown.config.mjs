export default {
  // Single entry：capture facade is statically imported into src/client.js and
  // bundled as the classic-script client artifact expected by DSH Web。
  entry: ["src/client.js"],
  format: ["esm"],
  outDir: "lib",
  clean: false,
  external: [/@deepseek-ai\//, "react"],
};
