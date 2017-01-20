var
  fs = require("fs"),
  path = require("path"),
  slug = require("slug"),
  atob = require("atob"),
  Mustache = require("mustache"),
  Directory = require("./lib/directory.js"),
  Summary = require("./lib/summary.js"),
  R = require("ramda");

if (!Object.assign) {
  Object.assign = require("object-assign");
}

/**
 * Rouds a number to the supplied decimals. Only makes sense for floats!
 * @param decimals The maximum number of decimals expected.
 * @param number The number to round.
 * @returns {number} The rounded number. Always returns a float!
 */
var round = function (decimals, number) {
  return Math.round(number * Math.pow(10, decimals)) / parseFloat(Math.pow(10, decimals));
};

function getDataUri(file) {
  var bitmap = fs.readFileSync(file);
  return new Buffer(bitmap).toString("base64");
}

var defaultTemplate = path.join(__dirname, "templates", "sample.html");

var CucumberHtmlReport = module.exports = function(options) {
  this.options = options || {};
};

CucumberHtmlReport.prototype.createReport = function() {
  var options = this.options;
  var features = parseFeatures(options, loadCucumberReport(this.options.source));

  durationCounter(features);

  var templateFile = options.template || defaultTemplate;
  var template = loadTemplate(templateFile);
  var stepsSummary = [];
  var scenarios = [];

  //Extracts steps from the features.
  features.map(function (feature, index) {
    feature.index = index;
    var steps = R.compose(
        R.flatten(),
        R.map(function (scenario) {
          return scenario.steps;
        }),
        R.filter(function (element) {
          return element.type === "scenario";
        })
    )(feature.elements);
    
    stepsSummary.push({
      "all": 0,
      "passed": 0,
      "skipped": 0,
      "failed": 0
    });

    //Counts the steps based on their status.
    steps.map(function (step) {
      switch (step.result.status) {
        case "passed":
          stepsSummary[index].all++;
          stepsSummary[index].passed++;
          break;
        case "skipped":
          stepsSummary[index].all++;
          stepsSummary[index].skipped++;
          break;
        default:
          stepsSummary[index].all++;
          stepsSummary[index].failed++;
          break;
      }
      stepDurationConverter(step);
    });

    scenarios.push({
      all: 0,
      passed: 0,
      failed: 0
    });

    R.compose(
      R.map(function (status) {
        scenarios[index].all++;
        scenarios[index][status]++;
      }),
      R.flatten(),
      R.map(function (scenario) {
        return scenario.status;
      }),
      R.filter(function (element) {
        return element.type === "scenario";
      })
    )(feature.elements);

  });

  var scenariosSummary = R.compose(
      R.filter(function (element) {
        return element.type === "scenario";
      }),
      R.flatten(),
      R.map(function (feature) {
        return feature.elements
      })
  )(features);

  var summary = Summary.calculateSummary(features);
  //Replaces "OK" and "NOK" with "Passed" and "Failed".
  summary.status = summary.status === "OK" ? "passed" : "failed";

  var tags = mappingTags(features);  
  var tagsArray = createTagsArray(tags);

  var mustacheOptions = Object.assign({}, options, {
    features: features,
    featuresJson: JSON.stringify(R.pluck("name", scenariosSummary)),
    stepsSummary: stepsSummary,
    scenariosSummary: JSON.stringify(scenariosSummary),
    stepsJson: JSON.stringify(stepsSummary),
    scenarios: scenarios,
    scenariosJson: JSON.stringify(scenarios),
    summary: summary,
    logo: encodeLogo(options.logo),
    charts: displayCharts(options),
    screenshots: encodeScreenshot(options),
    tags: tagsArray,
    tagsJson: JSON.stringify(tagsArray),
    image: mustacheImageFormatter,
    duration: mustacheDurationFormatter
  });

  var html = Mustache.to_html(template, mustacheOptions);
  saveHTML(options.dest, options.name, html);
  console.log("Report created successfully!");

  return true;
};

function durationCounter(features){
  R.map(function (feature) {
      var duration = R.compose(
        R.reduce(function (accumulator, current) {
          return accumulator + current;
        }, 0),
        R.flatten(),
        R.map(function (step) {
          return step.result.duration ? step.result.duration : 0;
        }),
        R.flatten(),
        R.map(function (element) {
          return element.steps;
        })
      )(feature.elements);

      if (duration && duration / 60000000000 >= 1) {

        //If the test ran for more than a minute, also display minutes.
        feature.duration = Math.trunc(duration / 60000000000) + " m " + round(2, (duration % 60000000000) / 1000000000) + " s";
      } else if (duration && duration / 60000000000 < 1) {

        //If the test ran for less than a minute, display only seconds.
        feature.duration = round(2, duration / 1000000000) + " s";
      }
      
  })(features);
}

function createTagsArray(tags){
  return (function (tags) {
    var array = [];
    
    for (var tag in tags) {
      if (tags.hasOwnProperty(tag)) {
        
        //Converts the duration from nanoseconds to seconds and minutes (if any)
        var duration = tags[tag].duration;
        if (duration && duration / 60000000000 >= 1) {

          //If the test ran for more than a minute, also display minutes.
          tags[tag].duration = Math.trunc(duration / 60000000000) + " m " + round(2, (duration % 60000000000) / 1000000000) + " s";
        } else if (duration && duration / 60000000000 < 1) {

          //If the test ran for less than a minute, display only seconds.
          tags[tag].duration = round(2, duration / 1000000000) + " s";
        }
        
        array.push(tags[tag]);
      }
    }
    return array;
  })(tags);
}

function encodeScreenshot(options){
  if(!options.screenshots) {
    return undefined;
  } else {
    return fs.readdirSync(options.screenshots).map(function (file) {
      if (file[0] === ".") { return undefined; };

      var name = file.split(".");
      var extension = name.pop();
      extension === "svg" ? extension = "svg+xml" : false;
      return {
        name: name.join(".").replace(/\s/, "_"),
        url: "data:image/" + extension + ";base64," + getDataUri(options.screenshots + "/" + file)
      };
    }).filter(function (image) {
      return image;
    });
  }
}

function stepDurationConverter(step){
  //Converts the duration from nanoseconds to seconds and minutes (if any)
  var duration = step.result.duration;
  if (duration && duration / 60000000000 >= 1) {

    //If the test ran for more than a minute, also display minutes.
    step.result.convertedDuration = Math.trunc(duration / 60000000000) + " m " + round(2, (duration % 60000000000) / 1000000000) + " s";
  } else if (duration && duration / 60000000000 < 1) {

    //If the test ran for less than a minute, display only seconds.
    step.result.convertedDuration = round(2, duration / 1000000000) + " s";
  }
}

function mappingTags(features) {
  var tags = {};
  features.map(function (feature) {

    [].concat(feature.tags).map(function (tag) {

      if (!(tag in tags)) {
        tags[tag] = {
          name: tag,
          scenarios: {
            all: 0,
            passed: 0,
            failed: 0
          },
          steps: {
            all: 0,
            passed: 0,
            failed: 0,
            skipped: 0
          },
          duration: 0,
          status: "passed"
        };
      }

      feature.elements.map(function (element) {
        if (element.type === "scenario") {
          tags[tag].scenarios.all++;
          tags[tag].scenarios[element.status]++;
        }
        
        element.steps.map(function (step) {
          if (step.result.duration) {
            tags[tag].duration += step.result.duration;
          }
          tags[tag].steps.all++;
          tags[tag].steps[step.result.status]++;
        });
      });

      if(tags[tag].scenarios.failed > 0) {
        tags[tag].status = "failed";
      }
    })
  }); 
  return tags; 
}

function displayCharts(options) {
  if(!options.displayCharts) {
    return undefined;
  } else {
    return true;
  }
}

function isValidStep(step) {
  return step.name !== undefined;
}

function loadCucumberReport(fileName) {
  return JSON.parse(fs.readFileSync(fileName, "utf-8").toString());
}

function parseFeatures(options, features) {
  return features
    .map(getFeatureStatus)
    .map(parseTags)
    .map(function(feature) {
      return processScenarios(feature, options);
    });
}

function loadTemplate(templateFile) {
  return fs.readFileSync(templateFile).toString();
}

function createFileName(name) {
  return slug(name, "_");
}

function saveHTML(targetDirectory, reportName, html) {
  fs.writeFileSync(path.join(targetDirectory, reportName || "index.html"), html);
}

function writeImage(fileName, data) {
  fs.writeFileSync(fileName, new Buffer(data, "base64"));
  console.log("Wrote %s", fileName);
}

function getFeatureStatus(feature) {
  feature.status = Summary.getFeatureStatus(feature);
  return feature;
}

function getScenarioStatus(scenario) {
  return Summary.getScenarioStatus(scenario);
}

function parseTags(feature) {
  if (feature.tags !== undefined) {
    feature.tags = feature.tags.map(function(tag) {
      return tag.name;
    }).join(", ");
  } else {
    feature.tags = "";
  }
  return feature;
}

function isScenarioType(scenario){
  return scenario.type === "scenario";
}

function processScenario(options) {
  return function(scenario) {
    scenario.status = getScenarioStatus(scenario);
    saveEmbeddedMetadata(options.dest, scenario, scenario.steps);
    scenario.steps = scenario.steps.filter(isValidStep);
  }
}

function processScenarios(feature, options) {
  var scenarios = (feature.elements || []).filter(isScenarioType);
  scenarios.forEach(processScenario(options));
  return feature;
}

function saveEmbeddedMetadata(destPath, element, steps) {
  steps = steps || [];
  steps.forEach(function(step) {
    if (step.embeddings) {
      step.embeddings.forEach(function(embedding) {
        if (embedding.mime_type === "image/png") {
          var imageName = createFileName(element.name + "-" + element.line) + ".png";
          var fileName = path.join(destPath, imageName);
          // Save imageName on element so we use it in HTML
          element.imageName = imageName;
          writeImage(fileName, embedding.data);
        }
        else if (embedding.mime_type === "text/plain") {
          // Save plain text on element so we use it in HTML
          element.plainTextMetadata = element.plainTextMetadata || [];

          var decodedText = atob(embedding.data);
          element.plainTextMetadata.push(decodedText);
        }
        else if (embedding.mime_type === 'text/html') {
          // Save html text on element so we use as embeded HTML
          element.htmlTextMetadata = element.htmlTextMetadata || [];

          var decodedText = atob(embedding.data);
          element.htmlTextMetadata.push(decodedText);
        }
      });
    }
  });
}

function mustacheImageFormatter() {
  return function (text, render) {
    var src = render(text);
    if (src.length > 0) {
      return "<img src=" + src + "/>";
    } else {
      return "";
    }
  };
}

function mustacheDurationFormatter() {
  // nanoseconds according to:
  // https://groups.google.com/forum/#!topic/cukes/itAKGVwJHFg
  return function(text, render) {
    return render(text);
  };
}

function encodeLogo (logoPath) {
  var logoExtension = logoPath.split(".").pop();
  return "data:image/" + (logoExtension === "svg" ? "svg+xml" : logoExtension) + ";base64," + getDataUri(logoPath);
}