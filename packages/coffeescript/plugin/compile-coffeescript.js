var fs = Npm.require('fs');
var path = Npm.require('path');
var coffee = Npm.require('coffee-script');

var handler = function (compileStep) {
  var source = compileStep.read().toString('utf8');
  var options = {
    bare: true,
    filename: compileStep.inputPath,
    literate: path.extname(compileStep.inputPath) === '.litcoffee'
  };

  try {
    var output = coffee.compile(source, options);
  } catch (e) {
    return bundle.error(e.message);
  }

  compileStep.addJavaScript({
    path: compileStep.inputPath + ".js",
    data: output
  });
};

Plugin.registerSourceHandler("coffee", handler);
Plugin.registerSourceHandler("litcoffee", handler);

