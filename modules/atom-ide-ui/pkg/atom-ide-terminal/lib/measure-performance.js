/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 * @format
 */

import featureConfig from 'nuclide-commons-atom/feature-config';
import performanceNow from 'nuclide-commons/performanceNow';
import UniversalDisposable from 'nuclide-commons/UniversalDisposable';
import {Terminal as XTerminal} from 'xterm';
import {track} from 'nuclide-commons/analytics';
import {RENDERER_TYPE_CONFIG} from './config';

// Tune the parameters for performance measurement.
const SLOW_CANVAS_RENDER_THRESHOLD = 66; // in ms
const NUMBER_OF_FRAMES_TO_MEASURE = 20;

/**
 * Track the performance of the canvas terminal renderer and offer switching to
 * the DOM-based fallback if we detect slow rendering.
 */
export default function measurePerformance(terminal: XTerminal): IDisposable {
  // If the terminal isn't using the canvas renderer, do nothing.
  if (terminal.getOption('rendererType') !== 'canvas') {
    return new UniversalDisposable();
  }
  // Similar to https://github.com/Microsoft/vscode/commit/84eb4778f18215d00608ccf8fb7649e6f2cd428a
  let frameTimes = [];
  let evaluated = false;
  // $FlowIgnore: using unofficial _core interface defined in https://github.com/Microsoft/vscode/blob/master/src/typings/vscode-xterm.d.ts#L682-L706
  const textRenderLayer = terminal._core.renderer._renderLayers[0];
  const originalOnGridChanged = textRenderLayer.onGridChanged;

  const evaluateCanvasRenderer = () => {
    evaluated = true;
    // Discard first frame time as it's normal to take longer
    frameTimes.shift();

    const averageTime = frameTimes.reduce((p, c) => p + c) / frameTimes.length;
    track('nuclide-terminal.render-performance', {averageTime});
    if (averageTime > SLOW_CANVAS_RENDER_THRESHOLD) {
      const notification = atom.notifications.addWarning(
        `The terminal GPU-based rendering appears to be slow on your computer (average frame render time was ${averageTime.toFixed(
          2,
        )}ms), do you want to use the fallback non-GPU renderer?`,
        {
          dismissable: true,
          buttons: [
            {
              text: 'Yes',
              onDidClick: () => {
                notification.dismiss();
                featureConfig.set(RENDERER_TYPE_CONFIG, 'dom');
                atom.notifications.addSuccess(
                  'All new terminals launched will use the non-GPU renderer',
                );
              },
            },
            {text: 'No', onDidClick: () => notification.dismiss()},
            {
              text: "No, don't show again",
              onDidClick: () => {
                featureConfig.set(RENDERER_TYPE_CONFIG, 'canvas');
                notification.dismiss();
              },
            },
          ],
        },
      );
    }
  };

  textRenderLayer.onGridChanged = (
    term: XTerminal,
    firstRow: number,
    lastRow: number,
  ) => {
    const startTime = performanceNow();
    originalOnGridChanged.call(textRenderLayer, term, firstRow, lastRow);
    frameTimes.push(performanceNow() - startTime);
    if (frameTimes.length === NUMBER_OF_FRAMES_TO_MEASURE) {
      evaluateCanvasRenderer();
      // Restore original function
      textRenderLayer.onGridChanged = originalOnGridChanged;
    }
  };
  return new UniversalDisposable(() => {
    if (!evaluated) {
      // Restore original function if we haven't done that already.
      textRenderLayer.onGridChanged = originalOnGridChanged;
    }
    // Clear frame times because it won't be used again.
    frameTimes = [];
  });
}
