Package.describe({
  summary: "Javascript dialect with fewer braces and semicolons"
});

Package._transitional_registerBuildPlugin({
  name: "compileCoffeescript",
  use: [],
  sources: [
    'plugin/compile-coffeescript.js'
  ],
  npmDependencies: {"coffee-script": "1.5.0"}
});

Package.on_test(function (api) {
  api.use(['coffeescript', 'tinytest']);
  api.add_files([
    'coffeescript_tests.coffee',
    'coffeescript_strict_tests.coffee',
    'litcoffeescript_tests.litcoffee',
    'coffeescript_tests.js'
  ], ['client', 'server']);
});
