// AssignStore on the agent_host conversations row.
package main

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PgAssignStore claims on the row via a generation CAS.
type PgAssignStore struct {
	pool *pgxpool.Pool
}

// lookupSQL prefers the exact id, then the top-level short-id.
const lookupSQL = `
	SELECT id, COALESCE(host_pod, ''), host_generation, COALESCE(phase = 'Suspended', false)
	  FROM conversations
	 WHERE id = $1 OR sandbox_ref = 'conv-' || $1
	 ORDER BY (id = $1) DESC, (parent_id IS NULL) DESC
	 LIMIT 1`

func (s *PgAssignStore) Lookup(ctx context.Context, id string) (Assignment, bool, error) {
	var a Assignment
	err := s.pool.QueryRow(ctx, lookupSQL, id).Scan(&a.ConvID, &a.Pod, &a.Gen, &a.Suspended)
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, false, nil
	}
	return a, err == nil, err
}

// claimSQL: subagents follow their parent, others take the least-loaded pod.
// Leaving Suspended stops the controller detaching a revive.
const claimSQL = `
	WITH cand AS (SELECT unnest($3::text[]) AS pod),
	     load AS (
	       SELECT cand.pod, count(c.id) AS n
	         FROM cand LEFT JOIN conversations c ON c.host_pod = cand.pod AND c.parent_id IS NULL
	        GROUP BY cand.pod),
	     pick AS (
	       SELECT COALESCE(
	         (SELECT p.host_pod FROM conversations me JOIN conversations p ON p.id = me.parent_id
	           WHERE me.id = $1 AND p.host_pod = ANY($3::text[])),
	         (SELECT pod FROM load ORDER BY n, pod LIMIT 1)) AS pod)
	UPDATE conversations
	   SET host_pod = pick.pod, host_generation = host_generation + 1,
	       phase = CASE WHEN phase = 'Failed' THEN phase ELSE 'Assigned' END
	  FROM pick
	 WHERE id = $1 AND host_generation = $2 AND pick.pod IS NOT NULL
	RETURNING id, host_pod, host_generation`

func (s *PgAssignStore) Claim(ctx context.Context, convID string, seenGen int64, candidates []string) (Assignment, bool, error) {
	var a Assignment
	err := s.pool.QueryRow(ctx, claimSQL, convID, seenGen, candidates).Scan(&a.ConvID, &a.Pod, &a.Gen)
	if errors.Is(err, pgx.ErrNoRows) {
		// Lost the CAS: someone else assigned first.
		a, found, lerr := s.Lookup(ctx, convID)
		if lerr != nil {
			return Assignment{}, false, lerr
		}
		if !found {
			return Assignment{}, false, errors.New("conversation row vanished during claim")
		}
		return a, false, nil
	}
	return a, err == nil, err
}
