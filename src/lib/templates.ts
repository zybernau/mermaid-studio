export type MermaidThemeId = 'default' | 'dark' | 'forest' | 'neutral';

export interface Template {
  id: string;
  label: string;
  icon: string;
  description: string;
  code: string;
}

export const TEMPLATES: Template[] = [
  {
    id: 'flowchart',
    label: 'Flowchart',
    icon: '⌁',
    description: 'App signup flow with decisions',
    code: `flowchart TD
    A[User visits app] --> B{Logged in?}
    B -- Yes --> C[Show dashboard]
    B -- No --> D[Show landing page]
    D --> E[Sign up form]
    E --> F{Valid email?}
    F -- Yes --> G[Create account]
    F -- No --> E
    G --> C
    C --> H[Render widgets]
    H --> I[Done ✅]

    classDef primary fill:#6366f1,stroke:#4338ca,color:#fff,stroke-width:0;
    classDef ok fill:#10b981,stroke:#047857,color:#fff,stroke-width:0;
    class A,C,G,I primary;
    class H ok;
`,
  },
  {
    id: 'sequence',
    label: 'Sequence',
    icon: '⇄',
    description: 'Auth flow between client & services',
    code: `sequenceDiagram
    autonumber
    actor U as User
    participant W as Web App
    participant A as Auth API
    participant D as Database

    U->>W: Enter email + password
    W->>A: POST /login {email, hash}
    A->>D: findUser(email)
    D-->>A: user record
    A->>A: verify password
    alt valid credentials
        A-->>W: 200 + session token
        W-->>U: Redirect to dashboard 🎉
    else invalid
        A-->>W: 401 Unauthorized
        W-->>U: Show error toast
    end
`,
  },
  {
    id: 'class',
    label: 'Class',
    icon: '▣',
    description: 'Domain model for a shop',
    code: `classDiagram
    class Customer {
        +String id
        +String name
        +String email
        +placeOrder() Order
    }
    class Order {
        +String id
        +Date createdAt
        +Money total
        +addItem(item) void
        +checkout() Payment
    }
    class Product {
        +String sku
        +String title
        +Money price
        +Int stock
    }
    class Payment {
        <<abstract>>
        +Money amount
        +pay() Receipt
    }
    Customer "1" --> "*" Order : places
    Order "1" *-- "*" Product : contains
    Order --> Payment : paid by
`,
  },
  {
    id: 'state',
    label: 'State',
    icon: '◉',
    description: 'Media player lifecycle',
    code: `stateDiagram-v2
    [*] --> Idle
    Idle --> Loading : open track
    Loading --> Playing : buffered
    Loading --> Error : network fail
    Playing --> Paused : pause
    Paused --> Playing : resume
    Playing --> Buffering : stall
    Buffering --> Playing : recovered
    Playing --> Ended : track finished
    Ended --> Playing : replay
    Playing --> Idle : close
    Error --> Idle : dismiss
`,
  },
  {
    id: 'er',
    label: 'ER Diagram',
    icon: '⛁',
    description: 'Blog database schema',
    code: `erDiagram
    USER ||--o{ POST : writes
    USER ||--o{ COMMENT : leaves
    POST ||--o{ COMMENT : has
    POST }|--|| CATEGORY : belongs_to

    USER {
        uuid id PK
        string name
        string email UK
        datetime created_at
    }
    POST {
        uuid id PK
        uuid author_id FK
        string title
        text body
        datetime published_at
    }
    COMMENT {
        uuid id PK
        uuid post_id FK
        text body
    }
    CATEGORY {
        int id PK
        string slug UK
    }
`,
  },
  {
    id: 'gantt',
    label: 'Gantt',
    icon: '▤',
    description: 'Launch plan timeline',
    code: `gantt
    title Product Launch Plan
    dateFormat  YYYY-MM-DD
    axisFormat  %b %d

    section Design
    Wireframes           :done,    d1, 2026-10-01, 2026-10-06
    UI polish            :active,  d2, 2026-10-07, 2026-10-12

    section Build
    Editor + preview     :active,  b1, 2026-10-08, 2026-10-14
    Export & share       :         b2, 2026-10-13, 2026-10-18

    section Release
    Beta testing         :         r1, 2026-10-19, 2026-10-24
    Public launch 🎉     :milestone, r2, 2026-10-25, 0d
`,
  },
  {
    id: 'mindmap',
    label: 'Mindmap',
    icon: '☍',
    description: 'Brainstorm a launch',
    code: `mindmap
  root((Launch 🚀))
    Marketing
      Blog posts
      Social teasers
      Email drip
    Product
      Onboarding
      Templates gallery
      Export PNG
    Engineering
      Perf pass
      Error states
      E2E tests
`,
  },
  {
    id: 'pie',
    label: 'Pie',
    icon: '◔',
    description: 'Traffic sources',
    code: `pie title Traffic sources
    "Organic search" : 42
    "Direct" : 26
    "Social" : 18
    "Referral" : 14
`,
  },
];

export const DEFAULT_CODE = TEMPLATES[0].code;
