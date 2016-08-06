var
  fs = require('fs'),
  path = require('path'),
  slug = require('slug'),
  atob = require('atob'),
  Mustache = require('mustache'),
  Directory = require('./lib/directory'),
  Summary = require('./lib/summary');

  //Object.assign polyfill for older node versions
  if (!Object.assign) {
    Object.assign = require('object-assign');
  }

var defaultTemplate = path.join(__dirname, 'templates', 'default.html');

var CucumberHtmlReport = module.exports = function(options) {
  this.options = options || {};
};

CucumberHtmlReport.prototype.createReport = function() {
  var options = this.options;
  if (!checkOptions(options)) {
    return false;
  }

  var features = parseFeatures(options, loadCucumberReport(this.options.source));
  var templateFile = options.template || defaultTemplate;
  var template = loadTemplate(templateFile);
  var mustacheOptions = Object.assign(options, {
    title: options.title || 'Cucumber Report',
    component: options.component || '',
    features: features,
    summary: Summary.calculateSummary(features),
    image: mustacheImageFormatter,
    duration: durationInSeconds
  });

  var html = Mustache.to_html(template, mustacheOptions);
  saveHTML(options.dest, options.name, html);
  console.log('Report created successfully!');

  return true;
};

function isValidStep(step) {
  return true; //step.name !== undefined;
}

function loadCucumberReport(fileName) {
  return JSON.parse(fs.readFileSync(fileName, 'utf-8').toString());
}

function parseFeatures(options, features) {
  return features
    .map(getFeatureStatus)
    .map(parseTags)
    .map(function(feature) {
      return processScenarios(feature, options);
    });
}

function checkOptions(options) {
  // Make sure we have input file!
  if (!fs.existsSync(options.source)){
    console.error('Input file "'+ options.source + '" does not exist! Aborting');
    return false;
  }

  // Make sure we have template file!
  if (options.template && !fs.existsSync(options.template)){
    console.error('Template file "'+ options.template + '" does not exist! Aborting');
    return false;
  }

  // Create output directory if not exists
  if (!fs.existsSync(options.dest)) {
    Directory.mkdirpSync(options.dest);
    console.log('Created directory: %s', options.dest);
  }

  return true;
}

function loadTemplate(templateFile) {
  return fs.readFileSync(templateFile).toString();
}

function createFileName(name) {
  return slug(name, '_');
}

function saveHTML(targetDirectory, reportName, html) {
  fs.writeFileSync(path.join(targetDirectory, reportName || 'index.html'), html);
}

function writeImage(fileName, data) {
  fs.writeFileSync(fileName, new Buffer(data, 'base64'));
  console.log('Wrote %s', fileName);
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
    }).join(', ');
  } else {
    feature.tags = '';
  }
  return feature;
}

function isScenarioType(scenario){
  return scenario.type === 'scenario';
}

function processScenario(options) {
  return function(scenario) {
    scenario.status = getScenarioStatus(scenario);
    saveEmbeddedMetadata(options.dest, scenario, scenario.steps);
    scenario.steps = scenario.steps.filter(isValidStep);
    scenario.steps = scenario.steps.map(processStep);
  }
}

function processStep(step) {
  step.result.durationInMS = step.result.duration ? Math.round(step.result.duration / 1000000) : 0;
  return step;
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
        if (embedding.mime_type === 'image/png') {
          var imageName = createFileName(element.name + '-' + element.line) + '.png';
          var fileName = path.join(destPath, imageName);
          // Save imageName on element so we use it in HTML
          element.imageName = imageName;
          writeImage(fileName, embedding.data);
        }
        else if (embedding.mime_type === 'text/plain') {
          // Save plain text on element so we use it in HTML
          element.plainTextMetadata = element.plainTextMetadata || [];

          var decodedText = atob(embedding.data);
          element.plainTextMetadata.push(decodedText);
        }
      });
    }
  });
}

function mustacheImageFormatter() {
  return function (text, render) {
    var src = render(text);
    if (src.length > 0) {
      return '<img src="' + src + '"/>';
    } else {
      return '';
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

function durationInSeconds() {

  return function(text, render) {  
    var text =render(text);
    var elapsedTime = text / 1000000000;
    if (elapsedTime >= 60) {
            data = parseInt(elapsedTime / 60) + 'm ' + (elapsedTime % 60).toFixed(0) + 's';
        } else {
            data =  elapsedTime.toFixed(2) + 's';
        }      
    return data;
  };
}
