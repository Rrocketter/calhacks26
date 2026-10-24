export type CorpusDoc = {
  id: string;
  text: string;
  metadata: {
    type: 'calendar' | 'contact' | 'note' | 'email' | 'file';
    date: string;
    people: string;
    day?: string;
    time?: string;
    title?: string;
  };
};
