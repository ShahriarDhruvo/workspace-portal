---
name: competitive-programming
description: Use when solving a contest or online-judge problem in C++ (Codeforces, AtCoder, ICPC, LeetCode style), or when a solution gets a wrong answer, a runtime error or a time limit and has to be found out why.
---

# Competitive programming in C++

The compiler here is GCC 12: use `-std=gnu++20`. `<bits/stdc++.h>` and the policy-based data structures (`<ext/pb_ds/...>`) are there.

## Before writing code

1. Read the limits first. They decide the algorithm: about 10^8 simple operations fit in a second.
2. State the approach and its complexity in one or two lines, then write it.
3. Work the samples by hand when the statement is easy to misread.

## Build two ways

Debug, for every run until the answer is right. It stops at the first out-of-range index, overflow or bad pointer:

```bash
g++ -std=gnu++20 -O1 -g -Wall -Wextra -Wshadow -fsanitize=address,undefined -D_GLIBCXX_DEBUG -o sol_debug sol.cpp
```

Release, as a judge builds it, for timing only:

```bash
g++ -std=gnu++20 -O2 -o sol sol.cpp
```

Build and run in the project folder. Programs in /tmp cannot be run in this workspace.

## What goes wrong most

- Overflow: use `long long` whenever a sum or product can pass 2*10^9. Multiply as `1LL * a * b`.
- Slow input: start `main` with `ios::sync_with_stdio(false); cin.tie(nullptr);` and print `'\n'`, not `endl`.
- Many test cases: reset every global and every container per case. Size the reset by this case's n, not by the maximum.
- Recursion depth of 10^5 or more can overflow the stack: use an explicit stack or iterate.
- Comparing doubles: avoid them, or compare with an epsilon.

## When the answer is wrong: stress test

Do not stare at the code. Write the slow, obviously correct solution and a random generator of small inputs, then let them disagree:

```bash
g++ -std=gnu++20 -O2 -o brute brute.cpp && g++ -std=gnu++20 -O2 -o gen gen.cpp
for i in $(seq 1 1000); do
  ./gen "$i" > in.txt
  ./sol_debug < in.txt > out.txt && ./brute < in.txt > expected.txt || { echo "crash on seed $i"; break; }
  cmp -s out.txt expected.txt || { echo "differs on seed $i"; break; }
done
```

The generator takes its seed from `argv[1]` and keeps n small (at most 8 or so), so that the failing input can be read. Fix the cause the small input shows, then run the loop again from the start.

## Before handing in

- Both builds pass the samples, and the release build is within the time limit on the largest input the limits allow. Generate that input; do not guess.
- Nothing prints debug output to stdout.
