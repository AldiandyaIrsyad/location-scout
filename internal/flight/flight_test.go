package flight

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestDoReturnsValueUnshared(t *testing.T) {
	var g Group
	v, err, shared := g.Do("k", func() ([]byte, error) { return []byte("hi"), nil })
	if err != nil || string(v) != "hi" {
		t.Fatalf("Do = %q, %v; want hi, nil", v, err)
	}
	if shared {
		t.Fatal("a call with no concurrent callers must not be reported as shared")
	}
}

func TestDoPropagatesError(t *testing.T) {
	var g Group
	want := errors.New("boom")
	v, err, _ := g.Do("k", func() ([]byte, error) { return nil, want })
	if !errors.Is(err, want) || v != nil {
		t.Fatalf("Do = %q, %v; want nil, %v", v, err, want)
	}
}

func TestDoRunsAgainAfterCompletion(t *testing.T) {
	var g Group
	var n int
	fn := func() ([]byte, error) { n++; return []byte{byte(n)}, nil }

	g.Do("k", fn)
	v, _, _ := g.Do("k", fn)
	if n != 2 || v[0] != 2 {
		t.Fatalf("sequential calls should each run fn: n=%d v=%v", n, v)
	}
}

func TestDoDedupesConcurrentCalls(t *testing.T) {
	var g Group
	var runs atomic.Int32
	release := make(chan struct{})
	started := make(chan struct{})

	leaderDone := make(chan struct{})
	go func() {
		defer close(leaderDone)
		g.Do("k", func() ([]byte, error) {
			runs.Add(1)
			close(started)
			<-release
			return []byte("result"), nil
		})
	}()
	<-started

	const waiters = 10
	var wg sync.WaitGroup
	var sharedCount atomic.Int32
	for i := 0; i < waiters; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, err, shared := g.Do("k", func() ([]byte, error) {
				runs.Add(1)
				return []byte("other"), nil
			})
			if err != nil || string(v) != "result" {
				t.Errorf("waiter got %q, %v; want result, nil", v, err)
			}
			if shared {
				sharedCount.Add(1)
			}
		}()
	}
	time.Sleep(100 * time.Millisecond) // give the waiters time to join the in-flight call
	close(release)
	wg.Wait()
	<-leaderDone

	if n := runs.Load(); n != 1 {
		t.Fatalf("fn ran %d times; want 1", n)
	}
	if n := sharedCount.Load(); n != waiters {
		t.Fatalf("%d waiters reported shared; want %d", n, waiters)
	}
}

func TestDoLeaderReportsShared(t *testing.T) {
	var g Group
	release := make(chan struct{})
	started := make(chan struct{})
	var leaderShared bool

	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _, leaderShared = g.Do("k", func() ([]byte, error) {
			close(started)
			<-release
			return []byte("r"), nil
		})
	}()
	<-started
	go g.Do("k", func() ([]byte, error) { return nil, nil })
	time.Sleep(50 * time.Millisecond)
	close(release)
	<-done

	if !leaderShared {
		t.Fatal("leader must report shared=true when a caller joined its call")
	}
}

func TestDoDifferentKeysRunIndependently(t *testing.T) {
	var g Group
	release := make(chan struct{})
	started := make(chan struct{})
	go g.Do("a", func() ([]byte, error) {
		close(started)
		<-release
		return nil, nil
	})
	<-started

	done := make(chan struct{})
	go func() {
		g.Do("b", func() ([]byte, error) { return []byte("b"), nil })
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("call for key b blocked behind key a")
	}
	close(release)
}

func TestDoPanicReleasesKey(t *testing.T) {
	var g Group
	func() {
		defer func() { _ = recover() }()
		g.Do("k", func() ([]byte, error) { panic("boom") })
	}()

	v, err, _ := g.Do("k", func() ([]byte, error) { return []byte("ok"), nil })
	if err != nil || string(v) != "ok" {
		t.Fatalf("Do after panic = %q, %v; want ok, nil", v, err)
	}
}

func TestDoWaitersGetErrorWhenLeaderPanics(t *testing.T) {
	var g Group
	release := make(chan struct{})
	started := make(chan struct{})

	go func() {
		defer func() { _ = recover() }()
		g.Do("k", func() ([]byte, error) {
			close(started)
			<-release
			panic("boom")
		})
	}()
	<-started

	result := make(chan error, 1)
	go func() {
		_, err, _ := g.Do("k", func() ([]byte, error) { return nil, nil })
		result <- err
	}()
	time.Sleep(50 * time.Millisecond)
	close(release)

	select {
	case err := <-result:
		if err == nil {
			t.Fatal("waiter should receive an error when the leader panics")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter blocked forever after leader panic")
	}
}
