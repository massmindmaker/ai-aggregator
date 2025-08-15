/**
 * Test Results Processor
 * Processes Jest test results and generates detailed reports
 */

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

class TestResultsProcessor {
  constructor() {
    this.reportsDir = path.join(__dirname, '../reports');
    this.ensureReportsDirectory();
  }

  ensureReportsDirectory() {
    if (!fs.existsSync(this.reportsDir)) {
      fs.mkdirSync(this.reportsDir, { recursive: true });
    }
  }

  process(results) {
    try {
      // Generate summary report
      this.generateSummaryReport(results);
      
      // Generate detailed test report
      this.generateDetailedReport(results);
      
      // Generate performance metrics
      this.generatePerformanceMetrics(results);
      
      // Generate coverage summary
      this.generateCoverageSummary(results);
      
      // Save raw results
      this.saveRawResults(results);
      
      console.log(chalk.blue('\n📊 Test results processed successfully!'));
      console.log(chalk.gray(`Reports saved to: ${this.reportsDir}`));
      
      return results;
    } catch (error) {
      console.error(chalk.red('Error processing test results:'), error);
      return results;
    }
  }

  generateSummaryReport(results) {
    const summary = {
      timestamp: new Date().toISOString(),
      totalTests: results.numTotalTests,
      passedTests: results.numPassedTests,
      failedTests: results.numFailedTests,
      skippedTests: results.numPendingTests,
      successRate: (results.numPassedTests / results.numTotalTests * 100).toFixed(2),
      totalTime: results.testResults.reduce((sum, result) => sum + (result.perfStats?.end - result.perfStats?.start || 0), 0),
      testSuites: results.testResults.length,
      passedSuites: results.testResults.filter(r => r.numFailingTests === 0).length,
      failedSuites: results.testResults.filter(r => r.numFailingTests > 0).length
    };

    const reportPath = path.join(this.reportsDir, 'summary.json');
    fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));

    // Generate human-readable summary
    const humanSummary = this.generateHumanReadableSummary(summary);
    const humanReportPath = path.join(this.reportsDir, 'summary.md');
    fs.writeFileSync(humanReportPath, humanSummary);
  }

  generateHumanReadableSummary(summary) {
    const successIcon = summary.failedTests === 0 ? '✅' : '❌';
    
    return `# Test Results Summary ${successIcon}

## Overview
- **Total Tests**: ${summary.totalTests}
- **Passed**: ${summary.passedTests} (${summary.successRate}%)
- **Failed**: ${summary.failedTests}
- **Skipped**: ${summary.skippedTests}
- **Total Time**: ${(summary.totalTime / 1000).toFixed(2)}s

## Test Suites
- **Total Suites**: ${summary.testSuites}
- **Passed Suites**: ${summary.passedSuites}
- **Failed Suites**: ${summary.failedSuites}

## Status
${summary.failedTests === 0 
  ? '🎉 All tests passed!' 
  : `⚠️ ${summary.failedTests} test(s) failed. Please review the detailed report.`
}

Generated at: ${summary.timestamp}
`;
  }

  generateDetailedReport(results) {
    const detailedReport = {
      timestamp: new Date().toISOString(),
      testSuites: results.testResults.map(suite => ({
        name: suite.testFilePath.replace(process.cwd(), ''),
        status: suite.numFailingTests === 0 ? 'passed' : 'failed',
        duration: suite.perfStats?.end - suite.perfStats?.start || 0,
        tests: {
          total: suite.numPassingTests + suite.numFailingTests + suite.numPendingTests,
          passed: suite.numPassingTests,
          failed: suite.numFailingTests,
          skipped: suite.numPendingTests
        },
        failedTests: suite.testResults
          .filter(test => test.status === 'failed')
          .map(test => ({
            title: test.title,
            fullName: test.fullName,
            error: test.failureMessages?.[0] || 'Unknown error',
            duration: test.duration
          })),
        slowTests: suite.testResults
          .filter(test => test.duration > 5000)
          .map(test => ({
            title: test.title,
            duration: test.duration
          }))
      }))
    };

    const reportPath = path.join(this.reportsDir, 'detailed-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(detailedReport, null, 2));
  }

  generatePerformanceMetrics(results) {
    const performanceMetrics = {
      timestamp: new Date().toISOString(),
      totalExecutionTime: results.testResults.reduce(
        (sum, result) => sum + (result.perfStats?.end - result.perfStats?.start || 0), 
        0
      ),
      averageTestDuration: this.calculateAverageTestDuration(results),
      slowestTests: this.findSlowestTests(results),
      fastestTests: this.findFastestTests(results),
      suitesPerformance: results.testResults.map(suite => ({
        name: suite.testFilePath.replace(process.cwd(), ''),
        duration: suite.perfStats?.end - suite.perfStats?.start || 0,
        testsPerSecond: suite.numPassingTests / ((suite.perfStats?.end - suite.perfStats?.start || 1) / 1000)
      })).sort((a, b) => b.duration - a.duration)
    };

    const reportPath = path.join(this.reportsDir, 'performance-metrics.json');
    fs.writeFileSync(reportPath, JSON.stringify(performanceMetrics, null, 2));
  }

  calculateAverageTestDuration(results) {
    let totalDuration = 0;
    let totalTests = 0;

    results.testResults.forEach(suite => {
      suite.testResults.forEach(test => {
        if (test.duration) {
          totalDuration += test.duration;
          totalTests++;
        }
      });
    });

    return totalTests > 0 ? totalDuration / totalTests : 0;
  }

  findSlowestTests(results, limit = 10) {
    const allTests = [];
    
    results.testResults.forEach(suite => {
      suite.testResults.forEach(test => {
        if (test.duration) {
          allTests.push({
            name: test.fullName,
            duration: test.duration,
            suite: suite.testFilePath.replace(process.cwd(), '')
          });
        }
      });
    });

    return allTests
      .sort((a, b) => b.duration - a.duration)
      .slice(0, limit);
  }

  findFastestTests(results, limit = 10) {
    const allTests = [];
    
    results.testResults.forEach(suite => {
      suite.testResults.forEach(test => {
        if (test.duration) {
          allTests.push({
            name: test.fullName,
            duration: test.duration,
            suite: suite.testFilePath.replace(process.cwd(), '')
          });
        }
      });
    });

    return allTests
      .sort((a, b) => a.duration - b.duration)
      .slice(0, limit);
  }

  generateCoverageSummary(results) {
    if (!results.coverageMap) {
      return;
    }

    const coverageSummary = {
      timestamp: new Date().toISOString(),
      global: results.coverageMap.getCoverageSummary().toJSON(),
      files: {}
    };

    results.coverageMap.files().forEach(file => {
      const fileCoverage = results.coverageMap.fileCoverageFor(file);
      const summary = fileCoverage.toSummary();
      
      coverageSummary.files[file.replace(process.cwd(), '')] = {
        lines: summary.lines,
        functions: summary.functions,
        branches: summary.branches,
        statements: summary.statements
      };
    });

    const reportPath = path.join(this.reportsDir, 'coverage-summary.json');
    fs.writeFileSync(reportPath, JSON.stringify(coverageSummary, null, 2));
  }

  saveRawResults(results) {
    const rawResultsPath = path.join(this.reportsDir, 'raw-results.json');
    
    // Create a cleaned version without circular references
    const cleanResults = {
      success: results.success,
      numTotalTests: results.numTotalTests,
      numPassedTests: results.numPassedTests,
      numFailedTests: results.numFailedTests,
      numPendingTests: results.numPendingTests,
      testResults: results.testResults.map(suite => ({
        testFilePath: suite.testFilePath,
        numPassingTests: suite.numPassingTests,
        numFailingTests: suite.numFailingTests,
        numPendingTests: suite.numPendingTests,
        perfStats: suite.perfStats,
        testResults: suite.testResults.map(test => ({
          title: test.title,
          fullName: test.fullName,
          status: test.status,
          duration: test.duration,
          failureMessages: test.failureMessages
        }))
      }))
    };

    fs.writeFileSync(rawResultsPath, JSON.stringify(cleanResults, null, 2));
  }
}

// Export the processor function for Jest
module.exports = (results) => {
  const processor = new TestResultsProcessor();
  return processor.process(results);
};

// Export the class for direct usage
module.exports.TestResultsProcessor = TestResultsProcessor;