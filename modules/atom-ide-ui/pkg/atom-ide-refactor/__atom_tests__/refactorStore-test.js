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

import type {TextEdit} from 'nuclide-commons-atom/text-edit';
import type {NuclideUri} from 'nuclide-commons/nuclideUri';
import type {
  FreeformRefactorRequest,
  RefactorProvider,
  RefactorRequest,
  RenameRequest,
  AvailableRefactoring,
  RefactorResponse,
} from '../lib/types';
import type {Store, RefactorState} from '../lib/types';

import {Observable, BehaviorSubject, Subject} from 'rxjs';
import {Range, Point} from 'atom';
import invariant from 'assert';

import ProviderRegistry from 'nuclide-commons-atom/ProviderRegistry';
import nuclideUri from 'nuclide-commons/nuclideUri';
import {Deferred, nextTick} from 'nuclide-commons/promise';
import {expectObservableToStartWith} from 'nuclide-commons/test-helpers';

import {getStore, getErrors} from '../lib/refactorStore';
import * as Actions from '../lib/refactorActions';

// sentinel value
const NO_ERROR = {};

// This tests the integration of the reducers and epics
describe('refactorStore', () => {
  let store: Store = (null: any);
  let providers: ProviderRegistry<RefactorProvider> = (null: any);
  let stateStream: Observable<RefactorState>;
  let currentState: BehaviorSubject<RefactorState>;

  let provider: RefactorProvider = (null: any);
  let refactoringsAtPointReturn: Promise<
    Array<AvailableRefactoring>,
  > = (null: any);
  let refactorReturn: Observable<RefactorResponse> = (null: any);
  let renameReturn: Promise<?Map<NuclideUri, Array<TextEdit>>>;

  let lastError: mixed = null;
  function expectNoUncaughtErrors(): void {
    // expect(lastError).toBe(NO_ERROR) results in 'obj.hasOwnProperty is not a function' in some
    // cases...
    expect(lastError === NO_ERROR).toBeTruthy();
  }

  let errorSubscription: rxjs$ISubscription = (null: any);

  const waitForPhase = (phaseType: string) => {
    return currentState
      .filter(s => {
        return s.type === 'open' && s.phase.type === phaseType;
      })
      .first()
      .toPromise();
  };

  const waitForClose = () => {
    return currentState
      .filter(s => s.type === 'closed')
      .first()
      .toPromise();
  };

  beforeEach(() => {
    lastError = NO_ERROR;
    errorSubscription = getErrors().subscribe(error => {
      lastError = error;
    });

    provider = {
      grammarScopes: ['text.plain', 'text.plain.null-grammar'],
      priority: 1,
      refactorings(
        editor: atom$TextEditor,
        range: atom$Range,
      ): Promise<Array<AvailableRefactoring>> {
        return refactoringsAtPointReturn;
      },
      refactor(request: RefactorRequest): Observable<RefactorResponse> {
        return refactorReturn;
      },
      rename(
        editor: TextEditor,
        position: atom$Point,
        newName: string,
      ): Promise<?Map<NuclideUri, Array<TextEdit>>> {
        return renameReturn;
      },
    };

    // TODO spy on the provider and call through
    refactoringsAtPointReturn = Promise.resolve([]);
    refactorReturn = Observable.empty();
    renameReturn = Promise.resolve();

    providers = new ProviderRegistry();
    store = getStore(providers);
    // $FlowIssue no symbol support
    const stream: Observable<RefactorState> = Observable.from(store);
    stateStream = stream
      // Filter out duplicate states. This happens during error handling, for example.
      .distinctUntilChanged()
      // publishReplay() and connect means it will
      .publishReplay();
    stateStream.connect();
    // stateStream will replay, but it's also useful to be able to wait for particular states before
    // proceeding.
    currentState = new BehaviorSubject(store.getState());
    stateStream.subscribe(currentState);
  });

  afterEach(() => {
    errorSubscription.unsubscribe();
  });

  it('starts closed', () => {
    expect(store.getState()).toEqual({type: 'closed'});
  });

  it('handles a missing editor', async () => {
    store.dispatch(Actions.open('generic'));
    await expectObservableToStartWith(stateStream, [
      {type: 'closed'},
      {
        type: 'open',
        ui: 'generic',
        phase: {type: 'get-refactorings'},
      },
      {type: 'closed'},
    ]);
  });

  describe('with an open text editor', () => {
    let openEditor: atom$TextEditor = (null: any);
    beforeEach(async () => {
      openEditor = await atom.workspace.open(TEST_FILE);
    });
    it('handles a missing provider', async () => {
      store.dispatch(Actions.open('generic'));
      await expectObservableToStartWith(stateStream, [
        {type: 'closed'},
        {
          type: 'open',
          ui: 'generic',
          phase: {type: 'get-refactorings'},
        },
        {type: 'closed'},
      ]);
    });

    describe('with an available provider', () => {
      beforeEach(() => {
        providers.addProvider(provider);
      });

      it('runs the refactor', async () => {
        refactorReturn = Observable.of({
          type: 'edit',
          edits: new Map([[TEST_FILE, TEST_FILE_EDITS]]),
        });
        const displayRenameRequest = [
          openEditor,
          provider,
          TEST_FILE_SELECTED_TEXT,
          TEST_FILE_MOUNT_POINT,
          TEST_FILE_SYMBOL_POINT,
        ];
        store.dispatch(Actions.displayRename(...displayRenameRequest));
        await waitForPhase('rename');
        const rename: RenameRequest = {
          kind: 'rename',
          position: TEST_FILE_SYMBOL_POINT,
          editor: openEditor,
          newName: 'bar',
        };
        store.dispatch(Actions.execute(provider, rename));
        await waitForClose();
        expect(openEditor.getText()).toEqual('bar\nbar\nbar\n');
      });

      it('does not allow refactoring of an unsaved file', async () => {
        await atom.workspace.open();
        store.dispatch(Actions.open('generic'));
        await expectObservableToStartWith(stateStream, [
          {type: 'closed'},
          {
            type: 'open',
            ui: 'generic',
            phase: {type: 'get-refactorings'},
          },
          {type: 'closed'},
        ]);
        await nextTick();
        expectNoUncaughtErrors();
      });

      it('tolerates a provider returning available refactorings after a close action', async () => {
        const deferred = new Deferred();
        refactoringsAtPointReturn = deferred.promise;
        store.dispatch(Actions.open('generic'));
        await waitForPhase('get-refactorings');
        store.dispatch(Actions.close());
        await waitForClose();
        deferred.resolve([]);
        await nextTick();
        expectNoUncaughtErrors();
      });

      it('tolerates a provider returning refactor results after a close action', async () => {
        const deferred = new Subject();
        refactorReturn = deferred;
        const displayRenameRequest = [
          openEditor,
          provider,
          TEST_FILE_SELECTED_TEXT,
          TEST_FILE_MOUNT_POINT,
          TEST_FILE_SYMBOL_POINT,
        ];
        store.dispatch(Actions.displayRename(...displayRenameRequest));
        await waitForPhase('rename');
        const rename: RenameRequest = {
          kind: 'rename',
          position: TEST_FILE_SYMBOL_POINT,
          editor: openEditor,
          newName: 'bar',
        };
        store.dispatch(Actions.execute(provider, rename));
        await waitForPhase('execute');
        store.dispatch(Actions.close());
        await waitForClose();
        deferred.next({
          type: 'edit',
          edits: new Map([[TEST_FILE, TEST_FILE_EDITS]]),
        });
        await nextTick();
        expectNoUncaughtErrors();
      });

      // TODO also test the method actually throwing, as well as returning a rejected promise.
      it('tolerates a provider throwing in refactoringsAtPoint', async () => {
        refactoringsAtPointReturn = Promise.reject(new Error());
        store.dispatch(Actions.open('generic'));
        await waitForPhase('get-refactorings');
        await waitForClose();
        await nextTick();
        expectNoUncaughtErrors();
      });

      // TODO also test the method actually throwing, as well as returning a rejected promise.
      it('tolerates a provider throwing in refactor', async () => {
        refactorReturn = Observable.throw(new Error());
        const displayRenameRequest = [
          openEditor,
          provider,
          TEST_FILE_SELECTED_TEXT,
          TEST_FILE_MOUNT_POINT,
          TEST_FILE_SYMBOL_POINT,
        ];
        store.dispatch(Actions.displayRename(...displayRenameRequest));
        await waitForPhase('rename');
        const rename: RenameRequest = {
          kind: 'rename',
          position: TEST_FILE_SYMBOL_POINT,
          editor: openEditor,
          newName: 'bar',
        };
        store.dispatch(Actions.execute(provider, rename));
        await waitForClose();
        await nextTick();
        expectNoUncaughtErrors();
      });

      it('tolerates a provider returning empty from refactor', async () => {
        refactorReturn = Observable.empty();
        const displayRenameRequest = [
          openEditor,
          provider,
          TEST_FILE_SELECTED_TEXT,
          TEST_FILE_MOUNT_POINT,
          TEST_FILE_SYMBOL_POINT,
        ];
        store.dispatch(Actions.displayRename(...displayRenameRequest));
        await waitForPhase('rename');
        const rename: RenameRequest = {
          kind: 'rename',
          position: TEST_FILE_SYMBOL_POINT,
          editor: openEditor,
          newName: 'bar',
        };
        store.dispatch(Actions.execute(provider, rename));
        await waitForClose();
        await nextTick();
        expectNoUncaughtErrors();
      });

      it('fails gracefully when the edits do not apply', async () => {
        const edits = [
          {
            oldRange: new Range([0, 0], [0, 3]),
            // intentionally not 'foo' in order to trigger a conflict when we attempt to apply this
            // edit.
            oldText: 'foz',
            newText: 'bar',
          },
        ];
        refactorReturn = Observable.of({
          type: 'edit',
          edits: new Map([[TEST_FILE, edits]]),
        });

        const displayRenameRequest = [
          openEditor,
          provider,
          TEST_FILE_SELECTED_TEXT,
          TEST_FILE_MOUNT_POINT,
          TEST_FILE_SYMBOL_POINT,
        ];
        store.dispatch(Actions.displayRename(...displayRenameRequest));
        await waitForPhase('rename');
        const rename: RenameRequest = {
          kind: 'rename',
          position: TEST_FILE_SYMBOL_POINT,
          editor: openEditor,
          newName: 'bar',
        };
        store.dispatch(Actions.execute(provider, rename));
        // TODO should display an error somewhere
        await waitForClose();
        expect(openEditor.getText()).toEqual('foo\nbar\nfoo\n');

        // TODO test this with multiple files. it will become much more complex. We need to make
        // sure that we can apply the entire refactoring transactionally. this means if something
        // goes wrong we need to roll back the rest.

        await nextTick();
        expectNoUncaughtErrors();
      });
    });

    describe('with a freeform provider', () => {
      const refactoring: AvailableRefactoring = {
        kind: 'freeform',
        id: 'asyncify',
        name: 'Asyncify',
        description: 'Convert this method to async',
        range: new Range([0, 0], [0, 0]),
        arguments: [
          {
            description: 'New name for method',
            name: 'new_name',
            type: 'string',
            default: 'genKittensAndRainbows',
          },
        ],
      };

      beforeEach(() => {
        provider = {
          priority: 1,
          grammarScopes: ['text.plain', 'text.plain.null-grammar'],
          async refactorings() {
            return [refactoring];
          },
          refactor(request: RefactorRequest) {
            invariant(request.kind === 'freeform');
            const edits = [
              {
                oldRange: new Range([0, 0], [0, 3]),
                oldText: 'foo',
                newText: String(request.arguments.get('new_name')),
              },
            ];
            return Observable.of({
              type: 'edit',
              edits: new Map([[TEST_FILE, edits]]),
            });
          },
        };
        providers.addProvider(provider);
      });

      it('runs the refactor', async () => {
        store.dispatch(Actions.open('generic'));
        await waitForPhase('pick');
        store.dispatch(Actions.pickedRefactor(refactoring));

        await waitForPhase('freeform');
        const state = store.getState();
        invariant(state.type === 'open');
        invariant(state.phase.type === 'freeform');
        expect(state.phase.refactoring).toEqual(refactoring);

        const asyncify: FreeformRefactorRequest = {
          kind: 'freeform',
          originalRange: new Range(
            TEST_FILE_SYMBOL_POINT,
            TEST_FILE_SYMBOL_POINT,
          ),
          editor: openEditor,
          id: 'asyncify',
          range: new Range([0, 0], [0, 0]),
          arguments: new Map([['new_name', 'test']]),
        };
        store.dispatch(Actions.execute(provider, asyncify));
        await waitForClose();
        expect(openEditor.getText()).toEqual('test\nbar\nfoo\n');
      });
    });
  });
});

// This is all just dummy data, so I'm keeping it down here to avoid drawing attention to it over
// the important test logic.
const TEST_FILE = nuclideUri.join(
  __dirname,
  '../__mocks__/fixtures',
  'refactor-fixture.txt',
);
const TEST_FILE_SELECTED_TEXT = 'foo';
const TEST_FILE_MOUNT_POINT = new Point(0, 0);
const TEST_FILE_SYMBOL_POINT = new Point(0, 1);
const TEST_FILE_EDITS = [
  {
    oldRange: new Range([0, 0], [0, 3]),
    oldText: TEST_FILE_SELECTED_TEXT,
    newText: 'bar',
  },
  {
    oldRange: new Range([2, 0], [2, 3]),
    oldText: TEST_FILE_SELECTED_TEXT,
    newText: 'bar',
  },
];
