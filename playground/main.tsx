import { configureStore, createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, useDispatch, useSelector } from 'react-redux';

interface Todo {
  id: number;
  title: string;
  done: boolean;
}

// ?devtools=0 creates the store without Redux DevTools support, which makes the
// extension fall back to finding it in the React tree ("limited" mode).
const devTools = new URLSearchParams(location.search).get('devtools') !== '0';

const fetchTodos = createAsyncThunk('todos/fetch', async () => {
  const res = await fetch('/api/todos');
  return (await res.json()) as Todo[];
});

const addTodo = createAsyncThunk('todos/add', async (title: string) => {
  const res = await fetch('/api/todos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  return (await res.json()) as Todo;
});

const counter = createSlice({
  name: 'counter',
  initialState: { value: 0 },
  reducers: {
    increment: (state) => void state.value++,
    decrement: (state) => void state.value--,
    set: (state, action: PayloadAction<number>) => void (state.value = action.payload),
  },
});

const todos = createSlice({
  name: 'todos',
  initialState: { items: [] as Todo[], status: 'idle' as 'idle' | 'loading' | 'failed', error: null as string | null },
  reducers: {
    toggle: (state, action: PayloadAction<number>) => {
      const todo = state.items.find((t) => t.id === action.payload);
      if (todo) todo.done = !todo.done;
    },
    clear: (state) => void (state.items = []),
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchTodos.pending, (state) => void (state.status = 'loading'))
      .addCase(fetchTodos.fulfilled, (state, action) => {
        state.status = 'idle';
        state.items = action.payload;
      })
      .addCase(fetchTodos.rejected, (state, action) => {
        state.status = 'failed';
        state.error = action.error.message ?? 'Failed';
      })
      .addCase(addTodo.fulfilled, (state, action) => void state.items.push(action.payload));
  },
});

const store = configureStore({
  reducer: { counter: counter.reducer, todos: todos.reducer },
  devTools,
});

type RootState = ReturnType<typeof store.getState>;
type AppDispatch = typeof store.dispatch;

function App() {
  const dispatch = useDispatch<AppDispatch>();
  const count = useSelector((s: RootState) => s.counter.value);
  const { items, status } = useSelector((s: RootState) => s.todos);
  const [title, setTitle] = useState('');
  const [log, setLog] = useState('');

  const request = async (label: string, input: string) => {
    const res = await fetch(input);
    setLog(`${label}: ${res.status} ${res.headers.get('content-type')}`);
  };

  return (
    <>
      <h1>DevKit playground</h1>
      <p>
        Store mode: <code>{devTools ? 'devTools enabled (hooked)' : 'devTools disabled (limited)'}</code> —{' '}
        <a href={devTools ? '?devtools=0' : '?'}>switch</a>
      </p>

      <section>
        <h2>Counter: {count}</h2>
        <button onClick={() => dispatch(counter.actions.increment())}>+1</button>
        <button onClick={() => dispatch(counter.actions.decrement())}>−1</button>
        <button onClick={() => dispatch(counter.actions.set(100))}>Set 100</button>
      </section>

      <section>
        <h2>Todos ({status})</h2>
        <button onClick={() => dispatch(fetchTodos())}>Fetch todos</button>
        <button onClick={() => dispatch(todos.actions.clear())}>Clear</button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) dispatch(addTodo(title.trim()));
            setTitle('');
          }}
        >
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New todo" /> <button>Add (POST)</button>
        </form>
        <ul>
          {items.map((todo) => (
            <li key={todo.id}>
              <label>
                <input type="checkbox" checked={todo.done} onChange={() => dispatch(todos.actions.toggle(todo.id))} /> {todo.title}
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Other requests</h2>
        <button onClick={() => request('slow', '/api/slow')}>Slow (1.5 s)</button>
        <button onClick={() => request('error', '/api/error')}>500 error</button>
        <button onClick={() => request('image', '/api/pixel.png')}>PNG image</button>
        <button onClick={() => request('text', '/api/text?lang=fi')}>Plain text</button>
        <button onClick={() => request('missing', '/api/missing')}>404</button>
        <p>{log}</p>
      </section>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <Provider store={store}>
    <App />
  </Provider>,
);
