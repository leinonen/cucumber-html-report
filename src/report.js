'use strict'

const R = require('ramda')
const fs = require('fs')
const path = require('path')
const atob = require('atob')
const moment = require('moment')
const Mustache = require('mustache')
const Directory = require('./directory')
const Summary = require('./summary')
const Template = require('./template')
const Duration = require('./duration')

if (!Object.assign) {
  Object.assign = require('object-assign')
}

exports.validate = function (options) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(options.source) || typeof options.source === 'undefined') {
      reject('Input file ' + options.source + ' does not exist! Aborting')
    }

    if (options.hasOwnProperty('template') && !fs.existsSync(options.template)) {
      reject('Template file ' + options.template + ' does not exist! Aborting')
    }

    if (!options.hasOwnProperty('name') || typeof options.name === 'undefined') {
      options.name = 'index.html'
    }

    if (!options.hasOwnProperty('dest') || typeof options.dest === 'undefined') {
      options.dest = './reports'
    }

    if (!options.hasOwnProperty('logo') || options.logo.length < 3) {
      options.logo = path.join(__dirname, '..', 'logos', 'cucumber-logo.svg')
    }

    if (!options.hasOwnProperty('screenshots') || typeof options.screenshots === 'undefined') {
      options.screenshots = false
    }

    if (!options.hasOwnProperty('maxScreenshots')) {
      options.maxScreenshots = 1000
    }

    if (!options.hasOwnProperty('sortReport') || typeof options.sortReport === 'undefined') {
      options.sortReport = true
    }

    options.timestamp = moment().format(options.dateformat || 'YYYY-MM-DD hh:mm:ss')

    resolve(options)
  })
}

exports.createDirectory = function (options) {
  return new Promise((resolve, reject) => {
    // Create output directory if not exists
    if (!fs.existsSync(options.dest)) {
      Directory.mkdirpSync(options.dest)
      console.log('Created directory: %s', options.dest)
    } else {
      console.log('Directory already exists: %s', options.dest)
    }
    resolve(options)
  })
}

exports.writeReport = function (mustacheOptions) {
  const template = Template.load(mustacheOptions.template || Template.defaultTemplate)
  const partials = mustacheOptions.template ? {} : Template.getTemplatePartials()
  const html = Mustache.render(template, mustacheOptions, partials)

  return writeHTML(mustacheOptions.dest, mustacheOptions.name, html)
}

/**
 * Create a report data structure that we can pass to Mustache.
 * @param options the configuration options
 * @returns {Promise}
 */
exports.createReport = function (options) {
  let features = parseFeatures(options, loadCucumberJson(options.source))
  let stepsSummary = []
  let scenarios = []
  const isCucumber2 = features.every(feature => feature.elements.every(scenario => scenario.type === undefined))

  durationCounter(features, isCucumber2)

  // Extracts steps from the features.
  features.map((feature, index) => {
    feature.index = index
    let steps = R.compose(
      R.flatten(),
      R.map(scenario => scenario.steps),
      R.filter(isScenarioType)
    )(feature.elements)

    stepsSummary.push({
      'all': 0,
      'passed': 0,
      'skipped': 0,
      'failed': 0
    })

    // Counts the steps based on their status.
    steps.map(step => {
      switch (step.result.status) {
        case 'passed':
          stepsSummary[index].all++
          stepsSummary[index].passed++
          break
        case 'skipped':
          stepsSummary[index].all++
          stepsSummary[index].skipped++
          break
        default:
          stepsSummary[index].all++
          stepsSummary[index].failed++
          break
      }
      stepDurationConverter(step, isCucumber2)
    })

    scenarios.push({
      all: 0,
      passed: 0,
      failed: 0
    })

    R.compose(
      R.map(status => {
        scenarios[index].all++
        scenarios[index][status]++
      }),
      R.flatten(),
      R.map(scenario => scenario.status),
      R.filter(isScenarioType)
    )(feature.elements)
  })

  let scenariosSummary = R.compose(
    R.filter(isScenarioType),
    R.flatten(),
    R.map(feature => feature.elements)
  )(features)

  let summary = Summary.calculateSummary(features)
  let tags = mappingTags(features)
  let tagsArray = createTagsArray(tags, isCucumber2)

  let mustacheOptions = Object.assign({}, options, {
    features: features,
    featuresJson: JSON.stringify(R.pluck('name', scenariosSummary)),
    stepsSummary: stepsSummary,
    scenariosSummary: JSON.stringify(scenariosSummary),
    stepsJson: JSON.stringify(stepsSummary),
    scenarios: scenarios,
    scenariosJson: JSON.stringify(scenarios),
    summary: summary,
    logo: encodeLogo(options.logo),
    screenshots: encodeScreenshot(options),
    tags: tagsArray,
    tagsJson: JSON.stringify(tagsArray),
    image: mustacheImageFormatter,
    duration: mustacheDurationFormatter
  })

  return Promise.resolve(mustacheOptions)
}

function durationCounter (features, isCucumber2) {
  R.map(feature => {
    let duration = R.compose(
      R.reduce((accumulator, current) => accumulator + current, 0),
      R.flatten(),
      R.map(step => step.result.duration ? step.result.duration : 0),
      R.flatten(),
      R.map(element => element.steps)
    )(feature.elements)

    if (Duration.isMinuteOrMore(duration, isCucumber2)) {
      // If the test ran for more than a minute, also display minutes.
      feature.duration = Duration.formatDurationInMinutesAndSeconds(duration, isCucumber2)
    } else if (Duration.isMinuteOrLess(duration, isCucumber2)) {
      // If the test ran for less than a minute, display only seconds.
      feature.duration = Duration.formatDurationInSeconds(duration, isCucumber2)
    }
  })(features)
}

function createTagsArray (tags, isCucumber2) {
  return (function (tags) {
    let array = []

    for (let tag in tags) {
      if (tags.hasOwnProperty(tag)) {
        // Converts the duration from nanoseconds to seconds and minutes (if any)
        let duration = tags[tag].duration
        if (Duration.isMinuteOrMore(duration, isCucumber2)) {
          // If the test ran for more than a minute, also display minutes.
          tags[tag].duration = Duration.formatDurationInMinutesAndSeconds(duration, isCucumber2)
        } else if (Duration.isMinuteOrLess(duration, isCucumber2)) {
          // If the test ran for less than a minute, display only seconds.
          tags[tag].duration = Duration.formatDurationInSeconds(duration, isCucumber2)
        }
        array.push(tags[tag])
      }
    }
    return array
  })(tags)
}

function stepDurationConverter (step, isCucumber2) {
  // Converts the duration from nanoseconds to seconds and minutes (if any)
  let duration = step.result.duration
  if (Duration.isMinuteOrMore(duration, isCucumber2)) {
    // If the test ran for more than a minute, also display minutes.
    step.result.convertedDuration = Duration.formatDurationInMinutesAndSeconds(duration, isCucumber2)
  } else if (Duration.isMinuteOrLess(duration, isCucumber2)) {
    // If the test ran for less than a minute, display only seconds.
    step.result.convertedDuration = Duration.formatDurationInSeconds(duration, isCucumber2)
  }
}

function mappingTags (features) {
  let tags = {}
  features.map(feature => {
    [].concat(feature.tags).map(tag => {
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
          status: 'passed'
        }
      }

      feature.elements.map(element => {
        if (isScenarioType(element)) {
          tags[tag].scenarios.all++
          tags[tag].scenarios[element.status]++
        }

        element.steps.map(step => {
          if (step.result.duration) {
            tags[tag].duration += step.result.duration
          }
          tags[tag].steps.all++
          tags[tag].steps[step.result.status]++
        })
      })

      if (tags[tag].scenarios.failed > 0) {
        tags[tag].status = 'failed'
      }
    })
  })
  return tags
}

function isValidStep (step) {
  return step.hidden === undefined || step.result.status.toLocaleLowerCase() === 'failed'
}

function loadCucumberJson (fileName) {
  return JSON.parse(fs.readFileSync(fileName, 'utf-8').toString())
}

function sortByStatusAndName (list, options) {
  var sortArray = [
    R.ascend(R.prop('status')),
    R.ascend(R.prop('name'))
  ]

  /* If the option sortReport is false leave the report sorted by execution chronology */
  if (!options.sortReport) {
    sortArray = [
      R.ascend(R.prop('line'))
    ]
  }

  return R.sortWith(sortArray, list)
}

function sortScenariosForFeature (feature) {
  feature.elements = sortByStatusAndName(feature.elements, this)
  return feature
}

function parseFeatures (options, features) {
  return sortByStatusAndName(features
    .map(getFeatureStatus)
    .map(parseTags)
    .map(processScenarios(options))
    .map(sortScenariosForFeature, options), options)
}

function createFileName (name) {
  /* eslint-disable no-control-regex */
  return name.toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x00-\x7F]/g, '')
      .replace(/([/\s'\-,])+/g, '_')
}

function writeHTML (targetDirectory, reportName, html) {
  return new Promise((resolve, reject) => {
    fs.writeFile(path.join(targetDirectory, reportName || 'index.html'), html, (error) => {
      if (error) {
        reject(error)
      } else {
        resolve('Report  created successfully!')
      }
    })
  })
}

function writeImage (fileName, data) {
  // fs.writeFileSync(fileName, new Buffer(data, 'base64'))
  fs.writeFile(fileName, new Buffer(data, 'base64'), (error) => {
    if (error) {
      console.log('Error writing', fileName, error)
    } else {
      console.log('Wrote', fileName)
    }
  })
}

function getFeatureStatus (feature) {
  feature.status = Summary.getFeatureStatus(feature)
  return feature
}

function getScenarioStatus (scenario) {
  return Summary.getScenarioStatus(scenario)
}

function parseTags (feature) {
  feature.tags = (feature.tags || []).map(tag => tag.name).join(', ')
  return feature
}

function isScenarioType (scenario) {
  return scenario.type === 'scenario' || scenario.keyword === 'Scenario'
}

function processScenario (options) {
  return function (scenario) {
    scenario.status = getScenarioStatus(scenario)
    saveEmbeddedMetadata(options.dest, scenario, scenario.steps, options.maxScreenshots)
    scenario.steps = scenario.steps.filter(isValidStep)
  }
}

function processScenarios (options) {
  return function (feature) {
    const scenarios = (feature.elements || []).filter(isScenarioType)
    scenarios.forEach(processScenario(options))
    return feature
  }
}

function saveEmbeddedMetadata (destPath, element, steps, maxScreenshots) {
  steps = steps || []
  steps.forEach(step => {
    if (step.embeddings) {
      let imgCount = 1
      step.embeddings.forEach(embedding => {
        if (embedding.mime_type === 'image/png' || (embedding.media && embedding.media.type === 'image/png')) {
          if (imgCount <= maxScreenshots) {
            handleEmbeddingPng(embedding, element, destPath, imgCount)
          }
          ++imgCount
        } else if (embedding.mime_type === 'text/plain') {
          handleEmbeddingPlainText(embedding, element)
        } else if (embedding.mime_type === 'text/log') {
          handleEmbeddingBrowserLog(embedding, element)
        }
      })
    }
  })
}

function handleEmbeddingPng (embedding, element, destPath, imgCount) {
  const imageName = createFileName(`${element.name}-${element.line}-${imgCount}`) + '.png'
  const fileName = path.join(destPath, imageName)
  // Save imageName on element so we use it in HTML
  element.imageName = element.imageName || []
  element.imageName.push(imageName)

  writeImage(fileName, embedding.data)
}

function handleEmbeddingPlainText (embedding, element) {
  // Save plain text on element so we use it in HTML
  element.plainTextMetadata = element.plainTextMetadata || []

  const decodedText = atob(embedding.data)
  element.plainTextMetadata.push(decodedText)
}

function handleEmbeddingBrowserLog (embedding, element) {
  element.logs = embedding.data.split('\n')
}

function mustacheImageFormatter () {
  return function (text, render) {
    let imgResult = ''
    let src = render(text)
    let imgList = src.split(',')
    if (src.length > 0 && imgList.length > 0) {
      imgResult = imgList.map(image => `<img src="${image}" />`).join('')
    }
    return imgResult
  }
}

function mustacheDurationFormatter () {
  return function (text, render) {
    return render(text)
  }
}

function getDataUri (file) {
  var bitmap = fs.readFileSync(file)
  return new Buffer(bitmap).toString('base64')
}

function encodeScreenshot (options) {
  if (!options.screenshots) {
    return undefined
  }

  return fs.readdirSync(options.screenshots).map(file => {
    if (file[0] === '.') {
      return undefined
    }

    let name = file.split('.')
    let extension = name.pop()
    extension === 'svg' ? extension = 'svg+xml' : false
    return {
      name: name.join('.').replace(/\s/, '_'),
      url: 'data:image/' + extension + ';base64,' + getDataUri(options.screenshots + '/' + file)
    }
  }).filter(image => image) // why?
}

function encodeLogo (logoPath) {
  const logoExtension = logoPath.split('.').pop()
  const extension = logoExtension === 'svg' ? 'svg+xml' : logoExtension
  return 'data:image/' + extension + ';base64,' + getDataUri(logoPath)
}
