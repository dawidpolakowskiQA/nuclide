/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */

/**
 * It tries to mimic what the top utility would report, but we have to do it manually because
 * different devices can have different versions of top.
 *
 * Reference for calculations: https://github.com/scaidermern/top-processes
 */

import type {Process} from './types';

import {Adb} from './Adb';
import {arrayCompact} from 'nuclide-commons/collection';
import {Observable} from 'rxjs';

type CPU_MEM = [number, number];

export class AdbTop {
  _adb: Adb;

  constructor(adb: Adb) {
    this._adb = adb;
  }

  fetch(): Observable<Process[]> {
    return Observable.forkJoin(
      this._adb.getProcesses().catch(() => Observable.of([])),
      this._adb.getJavaProcesses().catch(() => Observable.of([])),
      this._getProcessAndMemoryUsage().catch(() => Observable.of(new Map())),
    ).map(([processes, javaProcesses, cpuAndMemUsage]) => {
      const javaPids = new Set(
        javaProcesses.map(javaProc => Number(javaProc.pid)),
      );
      return arrayCompact(
        processes.map(x => {
          const info = x.trim().split(/\s+/);
          const pid = parseInt(info[1], 10);
          if (!Number.isInteger(pid)) {
            return null;
          }
          const cpuAndMem = cpuAndMemUsage.get(pid);
          let cpu = null;
          let mem = null;
          if (cpuAndMem != null) {
            cpu = parseFloat(cpuAndMem[0]);
            mem = parseFloat(cpuAndMem[1]);
          }
          const isJava = javaPids.has(pid);
          return {
            user: info[0],
            pid,
            name: info[info.length - 1],
            cpuUsage: cpu,
            memUsage: mem,
            isJava,
          };
        }),
      );
    });
  }

  _getProcessAndMemoryUsage(): Observable<Map<number, CPU_MEM>> {
    return Observable.interval(500)
      .startWith(0)
      .switchMap(() => {
        return Observable.forkJoin(
          this._getProcessesTime(),
          this._getGlobalCPUTime(),
        );
      })
      .take(2)
      .toArray()
      .map(times => {
        const [procTimePrev, cpuTimePrev] = times[0];
        const [procTime, cpuTime] = times[1];
        // pid => cpuUsage, memory usage
        const cpuAndMemUsage = new Map();
        const deltaCpu = cpuTime - cpuTimePrev;
        procTime.forEach((p1, pid) => {
          if (!procTimePrev.has(pid)) {
            return;
          }
          const p0 = procTimePrev.get(pid);
          if (p0 != null) {
            const deltaProc = p1[0] - p0[0];
            const memUsage = p1[1];
            cpuAndMemUsage.set(pid, [deltaProc / deltaCpu * 100, memUsage]);
          }
        });
        return cpuAndMemUsage;
      });
  }

  /**
   * Returns a map: pid => utime + stime
   */
  _getProcessesTime(): Observable<Map<number, CPU_MEM>> {
    // We look for the all the /proc/PID/stat files failing silently if the process dies as the
    // command runs.
    return this._adb.getProcStats().map(lines => {
      return new Map(
        lines.map(line => {
          const info = line.trim().split(/\s/);
          return [
            parseInt(info[0], 10),
            [
              parseInt(info[12], 10) + parseInt(info[13], 10), // stime + utime
              parseInt(info[23], 10), // RSS
            ],
          ];
        }),
      );
    });
  }

  _getGlobalCPUTime(): Observable<number> {
    return this._adb.getGlobalProcessStat().map(stdout => {
      return stdout.split(/\s+/).slice(1, -2).reduce((acc, current) => {
        return acc + parseInt(current, 10);
      }, 0);
    });
  }
}
