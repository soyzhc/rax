const { join, relative, dirname, resolve } = require('path');
const { existsSync } = require('fs-extra');
const chalk = require('chalk');

const { isNpmModule, isWeexModule, isRaxModule, isJsx2mpRuntimeModule } = require('./utils/judgeModule');

const RUNTIME = 'jsx2mp-runtime';

const getRuntimeByPlatform = (platform) => `${RUNTIME}/dist/jsx2mp-runtime.${platform}.esm`;

const getRuntimeRelativePath = (distSourcePath, outputPath) => './' + join(relative(dirname(distSourcePath), join(outputPath, 'npm')), RUNTIME);

const defaultOptions = {
  normalizeNpmFileName: (s) => s,
};

const transformPathMap = {};

module.exports = function visitor({ types: t }, options) {
  options = Object.assign({}, defaultOptions, options);
  const { normalizeNpmFileName, nodeModulesPathList, distSourcePath, resourcePath, outputPath, disableCopyNpm, platform } = options;
  const source = (value, npmList, rootContext) => {
    // Example:
    // value => '@ali/universal-goldlog' or '@ali/xxx/foo/lib'
    // npmList => ['/Users/xxx/node_modules/xxx', '/Users/xxx/node_modules/aaa/node_modules/bbb']
    // filename => '/Users/xxx/workspace/yyy/src/utils/logger.js'
    // rootContext => '/Users/xxx/workspace/yyy/'

    const searchPaths = npmList.reverse();
    const target = require.resolve(value, { paths: searchPaths });

    const rootNodeModulePath = join(rootContext, 'node_modules');
    const filePath = relative(dirname(distSourcePath), join(outputPath, 'npm', relative(rootNodeModulePath, target)));
    return t.stringLiteral(normalizeNpmFileName('./' + filePath));
  };

  // In WeChat miniapp, `require` can't get index file if index is omitted
  const ensureIndexInPath = (value, resourcePath) => {
    const target = require.resolve(resolve(dirname(resourcePath), value));
    const result = relative(dirname(resourcePath), target);
    return result[0] === '.' ? result : './' + result;
  };

  return {
    visitor: {
      ImportDeclaration(path, state) {
        const { value } = path.node.source;

        if (isNpmModule(value)) {
          if (isWeexModule(value)) {
            path.remove();
            return;
          }

          if (isRaxModule(value)) {
            const runtimePath = disableCopyNpm ? getRuntimeByPlatform(platform.type) : getRuntimeRelativePath(distSourcePath, outputPath);
            path.node.source = t.stringLiteral(runtimePath);
            transformPathMap[runtimePath] = true;
            return;
          }

          if (isJsx2mpRuntimeModule(value)) {
            const runtimePath = disableCopyNpm ? value : getRuntimeRelativePath(distSourcePath, outputPath);
            path.node.source = t.stringLiteral(runtimePath);
            transformPathMap[runtimePath] = true;
            return;
          }

          if (!disableCopyNpm) {
            const processedSource = source(value, nodeModulesPathList, state.cwd);
            // Add lock to avoid repeatly transformed in CallExpression if @babel/preset-env invoked
            transformPathMap[processedSource.value] = true;
            path.node.source = processedSource;
          }
        } else {
          const ensuredPath = ensureIndexInPath(value, resourcePath);
          path.node.source = t.stringLiteral(ensuredPath);
        }
      },

      CallExpression(path, state) {
        const { node } = path;
        if (
          node.callee.name === 'require' &&
          node.arguments &&
          node.arguments.length === 1
        ) {
          if (t.isStringLiteral(node.arguments[0])) {
            const moduleName = node.arguments[0].value;

            if (isNpmModule(moduleName)) {
              if (isWeexModule(moduleName)) {
                path.replaceWith(t.nullLiteral());
                return;
              }

              if (isRaxModule(moduleName)) {
                const runtimePath = disableCopyNpm ? getRuntimeByPlatform(platform.type) : getRuntimeRelativePath(distSourcePath, outputPath);
                path.node.arguments = [
                  t.stringLiteral(runtimePath)
                ];
                return;
              }

              if (isJsx2mpRuntimeModule(moduleName)) {
                const runtimePath = disableCopyNpm ? moduleName : getRuntimeRelativePath(distSourcePath, outputPath);
                path.node.arguments = [
                  t.stringLiteral(runtimePath)
                ];
                return;
              }

              if (!disableCopyNpm) {
                const processedSource = source(moduleName, nodeModulesPathList, state.cwd);
                transformPathMap[processedSource.value] = true;
                path.node.arguments = [ processedSource ];
              }
            } else {
              if (!transformPathMap[moduleName]) {
                path.node.arguments = [
                  t.stringLiteral(ensureIndexInPath(moduleName, resourcePath))
                ];
              }
            }
          } else if (t.isExpression(node.arguments[0])) {
            // require with expression, can not staticly find target.
            console.warn(chalk.yellow(`Critical requirement of "${path.toString()}", which have been removed at \n${state.filename}.`));
            path.replaceWith(t.nullLiteral());
          }
        }
      }
    }
  };
};
