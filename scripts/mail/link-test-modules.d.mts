export declare function linkTestModules(source: string, destination: string, platform?: string): Promise<void>;

export declare function unlinkTestModules(destination: string): Promise<void>;
export declare function removeTestTree(root: string): Promise<void>;
