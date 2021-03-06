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

jest.setTimeout(15000);

import fs from 'fs';
import nuclideUri from 'nuclide-commons/nuclideUri';
import watchman from 'fb-watchman';
import WatchmanClient from '../lib/WatchmanClient';
import {generateFixture} from 'nuclide-commons/test-helpers';
import waitsFor from '../../../jest/waits_for';

const FILE_MODE = 33188;

const sleep = n => new Promise(r => setTimeout(r, n));

describe.skip('WatchmanClient test suite', () => {
  let dirPath: string = '';
  let client: WatchmanClient = (null: any);

  beforeEach(async () => {
    client = new WatchmanClient();

    dirPath = await generateFixture(
      'watchman_helpers_test',
      new Map([
        // Many people use restrict_root_files so watchman only will watch folders
        // that have those listed files in them. watchmanconfig is always a root
        // file.
        ['.watchmanconfig', '{}'],
        ['test.txt', 'abc'],
        ['non-used-file.txt', 'def'],
        ['nested/nested-test.txt', 'ghi'],
      ]),
    );
    // TODO(hansonw): This is a big change in Watchman behavior- figure out what
    // this means for Nuclide's use.
    dirPath = fs.realpathSync(dirPath);
    await sleep(1010);
  });

  afterEach(() => {
    client.dispose();
  });

  describe('restore subscriptions', () => {
    async function testRestoreSubscriptions(
      onRestoreChange: (watchmanClient: watchman.Client) => void,
    ) {
      // First watchman init can be slow and flaky.
      const filePath = nuclideUri.join(dirPath, 'test.txt');
      const watcher = await client
        .watchDirectoryRecursive(dirPath)
        // Give it two retries.
        .catch(() => client.watchDirectoryRecursive(dirPath))
        .catch(() => client.watchDirectoryRecursive(dirPath));
      const changeHandler = jest.fn();
      watcher.on('change', changeHandler);
      await sleep(1010);
      fs.writeFileSync(filePath, 'def');
      await waitsFor(() => changeHandler.mock.calls.length > 0);
      expect(changeHandler.mock.calls.length).toBe(1);
      expect(changeHandler.mock.calls[0][0]).toEqual([
        {
          name: 'test.txt',
          mode: FILE_MODE,
          new: false,
          exists: true,
        },
      ]);
      const internalClient = await client._clientPromise;
      onRestoreChange(internalClient);
      internalClient.end();
      await sleep(1000); // Wait for watchman to watch the directory.
      advanceClock(3000); // Pass the settle filesystem time.
      await sleep(1000); // Wait for the client to restore subscriptions.
      fs.unlinkSync(filePath);
      await waitsFor(() => changeHandler.mock.calls.length > 1);
      expect(changeHandler.mock.calls.length).toBe(2);
      expect(changeHandler.mock.calls[1][0]).toEqual([
        {
          name: 'test.txt',
          mode: FILE_MODE,
          new: false,
          exists: false,
        },
      ]);
      // Cleanup watch resources.
      await (() => client.unwatch(dirPath))();
    }

    it('restores subscriptions on client end', async () => {
      await testRestoreSubscriptions(watchmanClient => {
        // End the socket client to watchman to trigger restore subscriptions.
        watchmanClient.end();
      });
    });

    it('restores subscriptions on client error', async () => {
      await testRestoreSubscriptions(watchmanClient => {
        // End the socket client to watchman to trigger restore subscriptions.
        watchmanClient.emit('error', new Error('fake error'));
      });
    });

    /**
     * This simulates the case where:
     * 1. watchman fails, and then
     * 2. the reconnection fails on startup
     * 3. subsequent reconnections can still succeed.
     *
     * We need to make sure we don't end up in a deadlock where the first reconnection
     * attempt blocks subsequent ones.
     */
    it('restores subscriptions on client startup failure', async () => {
      await testRestoreSubscriptions(watchmanClient => {
        let counter = 0;
        const oldConnect = watchman.Client.prototype.connect;
        jest
          .spyOn(watchman.Client.prototype, 'connect')
          .mockImplementation(function() {
            if (counter++ === 0) {
              this.emit('error', new Error('startup error'));
            } else {
              oldConnect.apply(this);
            }
          });
        watchmanClient.emit('error', new Error('fake error'));
      });
    });
  });

  describe('cleanup watchers after unwatch', () => {
    it('unwatch cleans up watchman subscriptions resources', async () => {
      const dirRealPath = fs.realpathSync(dirPath);
      await client.watchDirectoryRecursive(dirPath);
      const watchList = await client._watchList();
      expect(watchList.indexOf(dirRealPath)).not.toBe(-1);
      // $FlowIssue
      client.dispose = () => {};
      await client.unwatch(dirPath);
      expect(client.hasSubscription(dirPath)).toBeFalsy();
      // Didn't remove it from the watched directories.
      const noWatchListCleanup = await client._watchList();
      expect(noWatchListCleanup.indexOf(dirRealPath)).not.toBe(-1);
    });
  });

  describe('watchProject()', () => {
    it('should be able to watch nested project folders, but cleanup watchRoot', async () => {
      const dirRealPath = fs.realpathSync(dirPath);
      const nestedDirPath = nuclideUri.join(dirPath, 'nested');
      const {
        watch: watchRoot,
        relative_path: relativePath,
      } = await client._watchProject(nestedDirPath);
      expect(watchRoot).toBe(dirRealPath);
      expect(relativePath).toBe('nested');
    });
  });
});
